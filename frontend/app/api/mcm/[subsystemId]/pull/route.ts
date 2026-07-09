import { Request, Response } from 'express';
import { db, extractDeviceName } from '@/lib/db-sqlite';
import { configService } from '@/lib/config';
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types';
import { invalidateIoSubsystemCache, getMcmStatus } from '@/lib/mcm-registry';
import { getWsBroadcastUrl } from '@/lib/plc-client-manager';
import { createBackup } from '@/lib/db/backup';
import { computePullRiskOrRefuse } from '@/lib/cloud/pull-guard';
import { auditLog } from '@/lib/logging/recovery-log';
import { runConfigSidePulls } from '@/lib/cloud/config-side-pulls';

/**
 * L2/FV self-call — kept out of runConfigSidePulls so that helper has no
 * HTTP-server dependency. /api/cloud/pull-l2 does its own scoped delete+insert,
 * so this is idempotent and safe to call in both the full-pull and no-op paths.
 * Best-effort: an L2 failure must never fail (or throw out of) the IO pull.
 */
async function pullL2SelfCall(subsystemId: number, remoteUrl: string, apiPassword: string, force = false): Promise<number> {
  try {
    const port = process.env.PORT || '3000';
    const l2Res = await fetch(`http://127.0.0.1:${port}/api/cloud/pull-l2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Propagate force: an operator who explicitly confirmed the at-risk
      // overwrite shouldn't have the L2 leg refused by its own FV guard.
      body: JSON.stringify({ remoteUrl, apiPassword, subsystemId, force }),
      signal: AbortSignal.timeout(60_000),
    });
    const l2Data = await l2Res.json().catch(() => ({} as { l2Pulled?: number; devices?: number }));
    return l2Data.l2Pulled || l2Data.devices || 0;
  } catch (e) {
    console.warn(`[MCM ${subsystemId} Pull] L2 pull failed:`, e instanceof Error ? e.message : e);
    return 0;
  }
}

/**
 * Arm the auto-sync re-pull suppression after a scoped pull, exactly like the
 * legacy /api/cloud/pull route does. Without this, auto-sync's SSE-hint-driven
 * re-pull (auto-sync.ts guards keyed on _lastManualPullAt) never fires for the
 * scoped route, so a manual/background scoped pull was not debounced against an
 * immediate follow-up pull. Best-effort — a missing service must not fail the
 * pull the operator just completed successfully.
 */
async function armRePullSuppression(): Promise<void> {
  try {
    const { getAutoSyncService } = await import('@/lib/cloud/auto-sync');
    getAutoSyncService()?.markManualPull();
  } catch {
    // auto-sync not loaded yet — nothing to suppress.
  }
}

/**
 * POST /api/mcm/:subsystemId/pull
 *
 * Multi-MCM-safe cloud pull. Mirrors the legacy /api/cloud/pull logic but:
 *   - deletes only this subsystem's IOs (scoped delete, not the whole table)
 *   - reads remoteUrl + apiPassword from the shared config (not request body)
 *   - does NOT mutate config.subsystemId (legacy single-MCM field)
 *   - invalidates the mcm-registry IO→subsystem cache after upsert
 *
 * Each MCM can be pulled independently without clobbering data from any
 * other MCM. Network / EStop / Safety / Punchlists / L2 pulls are already
 * scoped by subsystem in the cloud API, so they layer on cleanly.
 */
export async function POST(req: Request, res: Response) {
  const subsystemIdStr = String(req.params.subsystemId);
  const subsystemId = parseInt(subsystemIdStr, 10);

  if (!Number.isFinite(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ success: false, error: 'subsystemId must be a positive integer' });
  }

  const force = req.body?.force === true;
  // Background catch-up pulls (auto-sync) skip the pre-pull backup when there's
  // nothing to recover — see the conditional backup below. Manual pulls omit
  // this flag and always back up.
  const isBackground = req.body?.background === true;

  try {
    const cfg = await configService.getConfig();
    const mcm = await configService.getMcm(subsystemIdStr);
    if (!mcm) {
      return res.status(404).json({ success: false, error: `MCM ${subsystemIdStr} not configured` });
    }

    // Refuse to pull while THIS MCM's PLC is connected (mirrors the legacy
    // route's guard): the pull rewrites this subsystem's Ios rows, and live
    // tag handles in the per-MCM client point at row IDs that would shift
    // mid-pull. Disconnect → Pull → Connect.
    const mcmStatus = getMcmStatus(subsystemIdStr);
    if (mcmStatus?.connected) {
      return res.status(409).json({
        success: false,
        error:
          `Disconnect MCM ${subsystemIdStr}'s PLC before pulling IOs — ` +
          'switching IO definitions while connected can corrupt live tag state.',
      });
    }

    const remoteUrl = (cfg.remoteUrl || EMBEDDED_REMOTE_URL).replace(/\/$/, '');
    const apiPassword = cfg.apiPassword || '';
    if (!apiPassword) {
      return res.status(400).json({
        success: false,
        error: 'No API password configured — set one via the legacy /api/configuration endpoint first',
      });
    }

    // Refuse to pull when there are unsynced local changes for this subsystem.
    // The legacy route guards the whole table; here we scope the guard by
    // subsystem so other MCMs' pending work doesn't block this one.
    //
    // B9 sweep (mirrors /api/cloud/pull): split ACTIVE rows (can still sync)
    // from PARKED rows (DeadLettered=1 — the cloud permanently rejected them,
    // they will NEVER sync, so "sync first" is impossible guidance). Both
    // still BLOCK this DESTRUCTIVE pull; the guidance differs.
    const pendingActive = (db
      .prepare(
        `SELECT COUNT(*) as cnt FROM PendingSyncs ps
         JOIN Ios i ON i.id = ps.IoId
         WHERE i.SubsystemId = ? AND ps.DeadLettered = 0`,
      )
      .get(subsystemId) as { cnt: number }).cnt;
    const pendingParked = (db
      .prepare(
        `SELECT COUNT(*) as cnt FROM PendingSyncs ps
         JOIN Ios i ON i.id = ps.IoId
         WHERE i.SubsystemId = ? AND ps.DeadLettered = 1`,
      )
      .get(subsystemId) as { cnt: number }).cnt;
    // E-stop EPC checks and guided-task overrides have their own offline push
    // queues, both keyed by SubsystemId. The scoped delete below cascades this
    // subsystem's E-stop check data and rewrites its guided state, so an
    // unsynced row in either queue for THIS subsystem is at risk too — block on
    // them exactly like IO. (Neither queue has a DeadLettered concept.)
    const pendingEStopCheck = (db
      .prepare('SELECT COUNT(*) as cnt FROM EStopCheckPendingSyncs WHERE SubsystemId = ?')
      .get(subsystemId) as { cnt: number }).cnt;
    const pendingGuidedTask = (db
      .prepare('SELECT COUNT(*) as cnt FROM GuidedTaskStatePendingSyncs WHERE SubsystemId = ?')
      .get(subsystemId) as { cnt: number }).cnt;
    if (pendingActive + pendingParked + pendingEStopCheck + pendingGuidedTask > 0) {
      const parts: string[] = [];
      if (pendingActive > 0) parts.push(`sync ${pendingActive} IO test change(s) first`);
      if (pendingParked > 0) {
        parts.push(
          `resolve ${pendingParked} flagged row(s) the cloud rejected ` +
          '(re-pass/fail/clear or accept in the grid — these cannot be synced)',
        );
      }
      if (pendingEStopCheck > 0) parts.push(`sync ${pendingEStopCheck} E-stop check result(s) first`);
      if (pendingGuidedTask > 0) parts.push(`sync ${pendingGuidedTask} guided-task update(s) first`);
      return res.status(409).json({
        success: false,
        error: `Pull blocked to protect unsynced local data for subsystem ${subsystemId}: ${parts.join('; ')}.`,
      });
    }

    const cloudUrl = `${remoteUrl}/api/sync/subsystem/${subsystemId}`;
    console.log(`[MCM ${subsystemIdStr} Pull] GET ${cloudUrl}`);

    let cloudResponse: globalThis.Response | null = null;
    let lastErr: unknown = null;
    const MAX_ATTEMPTS = 4;
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiPassword };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        cloudResponse = await fetch(cloudUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(attempt === 1 ? 25_000 : 30_000),
        });
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[MCM ${subsystemIdStr} Pull] attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
          err instanceof Error ? err.message : err);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
        }
      }
    }
    if (!cloudResponse) {
      return res.status(502).json({
        success: false,
        error: `Cloud unreachable after ${MAX_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      });
    }

    if (cloudResponse.status === 401) {
      return res.status(403).json({ success: false, error: 'Cloud authentication failed — check API password' });
    }
    if (cloudResponse.status === 403) {
      return res.status(403).json({
        success: false,
        error: `API password is not authorized for subsystem ${subsystemId}. Check the project ↔ API key mapping in the cloud.`,
      });
    }
    if (!cloudResponse.ok) {
      const text = await cloudResponse.text().catch(() => '');
      return res.status(502).json({ success: false, error: `Cloud error ${cloudResponse.status}: ${text.slice(0, 200)}` });
    }

    const cloudData = await cloudResponse.json();
    const cloudIos = cloudData.ios || cloudData.Ios || [];
    if (!Array.isArray(cloudIos) || cloudIos.length === 0) {
      return res.json({
        success: true,
        message: `No IOs returned for subsystem ${subsystemId}`,
        iosCount: 0,
        subsystemId,
      });
    }

    // ── No-op short-circuit (2026-06-16 MCM11 incident) ──────────────────
    // The AutoSync periodic safety catch-up calls this route for every active
    // MCM every ~15 min. Without this check it unconditionally took a full-DB
    // backup AND ran a destructive DELETE+reinsert of thousands of rows EVERY
    // cycle, even when the cloud data was byte-for-byte identical to last time
    // — the source of both the runaway backups and the constant WAL churn.
    // Mirror the change-detection the single-MCM pullFromCloud path already
    // uses (hash of id:version:result): if the cloud IO set is unchanged since
    // the last applied pull for THIS subsystem, skip the backup and the rewrite
    // entirely. Skipping a true no-op is safe — nothing destructive happens, so
    // no recovery point is needed. `force` always bypasses this. On process
    // restart the in-memory store is empty, so the first pull is always a full
    // pull (safe).
    const pullHashStore = ((globalThis as { __mcmPullHash?: Map<number, string> })
      .__mcmPullHash ??= new Map<number, string>());
    const versionHash = cloudIos
      .map((io: { id: number; version?: number; result?: string }) =>
        `${io.id}:${io.version ?? 0}:${io.result || '-'}`)
      .join('|');
    if (!force && pullHashStore.get(subsystemId) === versionHash) {
      // IO set unchanged → skip the destructive IO backup + delete/reinsert
      // (the MCM11 churn protection). But STILL refresh the config/FV sections:
      // network/estop/safety/L2 changes on the cloud do NOT move the IO hash, so
      // before this they were skipped here too and only reached the field after a
      // service restart cleared this in-memory hash. runConfigSidePulls is a
      // scoped, idempotent delete+reinsert per section, so this is safe.
      const side = await runConfigSidePulls(subsystemId, remoteUrl, apiPassword, { db });
      const l2Pulled = await pullL2SelfCall(subsystemId, remoteUrl, apiPassword);
      await armRePullSuppression();
      return res.json({
        success: true,
        unchanged: true,
        message: `No IO changes for MCM ${mcm.name} — refreshed config/FV only`,
        iosCount: cloudIos.length,
        subsystemId,
        networkPulled: side.networkPulled,
        estopPulled: side.estopPulled,
        safetyPulled: side.safetyPulled,
        punchlistsPulled: side.punchlistsPulled,
        l2Pulled,
      });
    }

    // ── Result-loss guard (2026-06-04 TPA8/MCM08 incident) ──────────────
    // Same second/third line of defense as the legacy /api/cloud/pull, scoped
    // to this subsystem: the pending-queue check above failed catastrophically
    // when the retry cap silently emptied the queue, so this guard ignores the
    // queue and compares actual local results/comments/clears against the actual
    // cloud payload. Override requires an explicit body.force after user
    // confirmation in the UI. Shared verbatim with the legacy route via
    // computePullRiskOrRefuse (subsystemId set = per-MCM scoped queries).
    const guard = computePullRiskOrRefuse(
      { db, subsystemId, logPrefix: `[MCM ${subsystemIdStr} Pull]` },
      cloudIos,
      force,
    );
    if (guard.refuse) {
      return res.status(guard.refuse.status).json(guard.refuse.body);
    }
    const { atRisk, atRiskComments, divergent, atRiskClears } = guard;

    // ── Pre-pull safety backup (moved AFTER the guard — B6 churn fix) ─────
    // The rewrite below is DESTRUCTIVE (scoped DELETE FROM Ios + reinsert). A
    // full-DB backup is the last line of recovery, so take one before any
    // delete — BUT skip it for BACKGROUND catch-up pulls that have nothing to
    // recover: those either refused above (at-risk → no write) or only re-apply
    // cloud state local already has. Taking a full-DB copy per MCM on every
    // ~15-min sweep was the source of the "backup every few minutes" churn.
    // Manual pulls — and any pull about to FORCE-overwrite at-risk data — always
    // back up.
    const mustBackup = !isBackground || (force && (atRisk.length > 0 || atRiskComments.length > 0 || divergent.length > 0 || atRiskClears.length > 0));
    if (mustBackup) {
      try {
        const backup = await createBackup(`pre-pull-mcm${subsystemId}`);
        console.log(`[MCM ${subsystemIdStr} Pull] Auto-backup created: ${backup.filename}`);
      } catch (backupErr) {
        console.error(`[MCM ${subsystemIdStr} Pull] Pre-pull backup FAILED — aborting to protect local data:`, backupErr);
        return res.status(500).json({
          success: false,
          error:
            'Pre-pull safety backup failed, so the pull was aborted to protect your local data. ' +
            'Check disk space / backups folder permissions and try again.',
        });
      }
    }

    // ── Scoped upsert ────────────────────────────────────────────────────
    const upsertStmt = db.prepare(`
      INSERT INTO Ios (id, Name, Description, SubsystemId, Result, Comments, Timestamp, TestedBy, IoNumber, InstallationStatus, InstallationPercent, PoweredUp, TagType, Version, Trade, ClarificationNote, NetworkDeviceName, PunchlistStatus, CloudSyncedAt, "Order")
      VALUES (@id, @Name, @Description, @SubsystemId, @Result, @Comments, @Timestamp, @TestedBy, @IoNumber, @InstallationStatus, @InstallationPercent, @PoweredUp, @TagType, @Version, @Trade, @ClarificationNote, @NetworkDeviceName, @PunchlistStatus, @CloudSyncedAt, @Order)
      ON CONFLICT(id) DO UPDATE SET
        Name = @Name, Description = @Description, SubsystemId = @SubsystemId,
        Result = CASE WHEN Ios.Result IS NOT NULL AND Ios.Result != '' THEN Ios.Result ELSE @Result END,
        Comments = CASE WHEN Ios.Comments IS NOT NULL AND Ios.Comments != '' THEN Ios.Comments ELSE @Comments END,
        Timestamp = CASE WHEN Ios.Timestamp IS NOT NULL THEN Ios.Timestamp ELSE @Timestamp END,
        TestedBy = CASE WHEN Ios.TestedBy IS NOT NULL AND Ios.TestedBy != '' THEN Ios.TestedBy ELSE @TestedBy END,
        IoNumber = @IoNumber, InstallationStatus = @InstallationStatus,
        InstallationPercent = @InstallationPercent, PoweredUp = @PoweredUp,
        TagType = CASE WHEN @TagType IS NOT NULL THEN @TagType ELSE Ios.TagType END,
        Version = @Version, Trade = @Trade, ClarificationNote = @ClarificationNote,
        NetworkDeviceName = @NetworkDeviceName,
        PunchlistStatus = CASE WHEN @PunchlistStatus IS NOT NULL THEN @PunchlistStatus ELSE Ios.PunchlistStatus END,
        CloudSyncedAt = @CloudSyncedAt,
        "Order" = @Order
    `);

    let result: number;
    try {
      result = db.transaction(() => {
      // TOCTOU guard: the pending check at the top of this handler ran BEFORE
      // the cloud fetch (an await). A test recorded during that fetch would slip
      // past it and then be clobbered by the DELETE below. Re-check pending here
      // — synchronously, atomically with the delete — and abort if one appeared.
      const pendingNow = (db
        .prepare(
          `SELECT COUNT(*) as cnt FROM PendingSyncs ps
           JOIN Ios i ON i.id = ps.IoId
           WHERE i.SubsystemId = ?`,
        )
        .get(subsystemId) as { cnt: number }).cnt;
      // Same TOCTOU window for the E-stop check / guided-task queues: a result
      // recorded during the cloud fetch above would slip past the top-of-handler
      // block and then be erased by the delete below. Re-check them atomically.
      const estopPendingNow = (db
        .prepare('SELECT COUNT(*) as cnt FROM EStopCheckPendingSyncs WHERE SubsystemId = ?')
        .get(subsystemId) as { cnt: number }).cnt;
      const guidedPendingNow = (db
        .prepare('SELECT COUNT(*) as cnt FROM GuidedTaskStatePendingSyncs WHERE SubsystemId = ?')
        .get(subsystemId) as { cnt: number }).cnt;
      if (pendingNow + estopPendingNow + guidedPendingNow > 0) {
        throw new Error('PENDING_APPEARED');
      }

      // Ensure Projects/Subsystems rows exist (mirrors legacy behavior).
      const existingProject = db.prepare('SELECT id FROM Projects WHERE id = 1').get();
      if (!existingProject) {
        db.prepare('INSERT INTO Projects (id, Name) VALUES (1, ?)').run('Default Project');
      }
      const existingSubsystem = db.prepare('SELECT id FROM Subsystems WHERE id = ?').get(subsystemId);
      if (!existingSubsystem) {
        db.prepare('INSERT INTO Subsystems (id, ProjectId, Name) VALUES (?, 1, ?)').run(
          subsystemId,
          mcm.name || `Subsystem ${subsystemId}`,
        );
      }

      // SCOPED delete — only this subsystem's IOs. Other MCMs' IOs survive.
      const deletedCount = db.prepare('DELETE FROM Ios WHERE SubsystemId = ?').run(subsystemId).changes;
      console.log(`[MCM ${subsystemIdStr} Pull] Cleared ${deletedCount} existing IOs for subsystem ${subsystemId}`);

      // NOTE: the network/estop/safety/punchlist scoped clears used to live here,
      // inside the IO transaction. They moved into runConfigSidePulls (called
      // below) so each config section is a self-contained delete+reinsert that
      // runs in BOTH the full-pull and the no-op-refresh path. Safety in
      // particular was previously deleted here but never re-inserted (data loss).

      let upserted = 0;
      for (const cloudIo of cloudIos) {
        if (!cloudIo.name || cloudIo.id <= 0) continue;
        try {
          upsertStmt.run({
            id: cloudIo.id,
            Name: cloudIo.name,
            Description: cloudIo.description ?? null,
            SubsystemId: subsystemId,
            Result: cloudIo.result ?? null,
            Comments: cloudIo.comments ?? null,
            Timestamp: cloudIo.timestamp ?? null,
            TestedBy: cloudIo.testedBy ?? null,
            IoNumber: cloudIo.order ?? null,
            InstallationStatus: cloudIo.installationStatus ?? null,
            InstallationPercent: cloudIo.installationPercent ?? null,
            PoweredUp: cloudIo.poweredUp === true ? 1 : cloudIo.poweredUp === false ? 0 : null,
            TagType: cloudIo.tagType ?? null,
            Version: Number(cloudIo.version) || 0,
            Trade: cloudIo.trade ?? null,
            ClarificationNote: cloudIo.clarificationNote ?? null,
            NetworkDeviceName: cloudIo.networkDeviceName ?? null,
            PunchlistStatus: cloudIo.punchlistStatus ?? null,
            CloudSyncedAt: new Date().toISOString(),
            Order: cloudIo.order ?? null,
          });
          upserted++;
        } catch (err) {
          console.error(`[MCM ${subsystemIdStr} Pull] Failed upsert id=${cloudIo.id}:`, err);
        }
      }

      // Backfill NetworkDeviceName from tag names where missing.
      const updateDevice = db.prepare('UPDATE Ios SET NetworkDeviceName = ? WHERE id = ?');
      const need = db
        .prepare('SELECT id, Name FROM Ios WHERE SubsystemId = ? AND NetworkDeviceName IS NULL')
        .all(subsystemId) as { id: number; Name: string }[];
      for (const io of need) {
        const dev = extractDeviceName(io.Name);
        if (dev) updateDevice.run(dev, io.id);
      }

      return upserted;
      })();
    } catch (txErr) {
      if (txErr instanceof Error && txErr.message === 'PENDING_APPEARED') {
        return res.status(409).json({
          success: false,
          error:
            'Pull skipped — a test was recorded for this MCM during the pull. ' +
            'Local data is preserved; the next safety pull will reconcile.',
        });
      }
      throw txErr;
    }

    // Invalidate the registry's IO→Subsystem lookup cache so per-IO routing
    // picks up the new rows immediately.
    invalidateIoSubsystemCache();

    // ── Side pulls (subsystem-scoped on cloud, additive in local DB) ─────
    // Network topology, EStop, Safety, Punchlists, L2 — copy the legacy
    // behavior, just without the global wipes.
    // Config side-pulls: network / estop / safety / punchlist. One scoped,
    // idempotent delete+reinsert per section, shared verbatim with the no-op
    // branch above so config/FV data refreshes on every pull (safety included —
    // it used to be deleted in the IO txn and never re-inserted). See
    // lib/cloud/config-side-pulls.ts. L2/FV is a separate self-call.
    const side = await runConfigSidePulls(subsystemId, remoteUrl, apiPassword, { db });
    const { networkPulled, estopPulled, safetyPulled, punchlistsPulled } = side;
    const l2Pulled = await pullL2SelfCall(subsystemId, remoteUrl, apiPassword);

    // Broadcast IOsUpdated so live UIs refresh.
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'IOsUpdated', subsystemId: subsystemIdStr, count: result }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // best-effort
    }

    // Record the applied cloud signature so the next periodic catch-up can
    // short-circuit if nothing changed (see no-op check above).
    pullHashStore.set(subsystemId, versionHash);

    // Suppress an immediate auto-sync re-pull now that this scoped pull applied
    // fresh cloud state (mirrors the legacy /api/cloud/pull route).
    await armRePullSuppression();

    console.log(`[MCM ${subsystemIdStr} Pull] DONE — ios=${result}, network=${networkPulled}, estop=${estopPulled}, safety=${safetyPulled}, punchlists=${punchlistsPulled}`);

    // Durable recovery-log trace of this DESTRUCTIVE pull (the no-op short-
    // circuit above rewrote nothing and is intentionally not logged). Log-only.
    auditLog({
      type: 'sync.pull',
      subsystemId,
      detail: {
        iosCount: result,
        networkPulled,
        estopPulled,
        safetyPulled,
      },
    });

    return res.json({
      success: true,
      subsystemId,
      message: `Pulled ${result} IOs for MCM ${mcm.name}`,
      iosCount: result,
      networkPulled,
      estopPulled,
      safetyPulled,
      punchlistsPulled,
      l2Pulled,
    });
  } catch (error) {
    console.error(`[MCM ${subsystemIdStr} Pull] error:`, error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
