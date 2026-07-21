import { Request, Response } from 'express';
import { db, extractDeviceName } from '@/lib/db-sqlite';
import { configService } from '@/lib/config';
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types';
import { invalidateIoSubsystemCache, getMcmStatus } from '@/lib/mcm-registry';
import { getWsBroadcastUrl } from '@/lib/plc-client-manager';
import { createBackup } from '@/lib/db/backup';
import { auditLog } from '@/lib/logging/recovery-log';
import { mcmTag } from '@/lib/logging/mcm-tag';
import { runConfigSidePulls } from '@/lib/cloud/config-side-pulls';
import { runFullPull } from '@/lib/cloud/pull-core';
import { pullExtraSections } from '@/lib/cloud/pull-extra-sections';
import { selectRefs, snapshotRefs, discard } from '@/lib/sync/queue-inspector';
import { writeDiscardLog } from '@/lib/sync/discard-log';
import { syncFirmwareBaseline } from '@/lib/cloud/firmware-baseline-sync';

/**
 * L2/FV self-call — kept out of runConfigSidePulls so that helper has no
 * HTTP-server dependency. /api/cloud/pull-l2 does its own scoped delete+insert,
 * so this is idempotent and safe to call in both the full-pull and no-op paths.
 * Best-effort: an L2 failure must never fail (or throw out of) the IO pull.
 */
async function pullL2SelfCall(
  subsystemId: number,
  remoteUrl: string,
  apiPassword: string,
  force = false,
): Promise<{ l2Pulled: number; l2CellsPulled: number; l2Error: string | null }> {
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
    const l2Data = await l2Res.json().catch(() => ({} as { success?: boolean; error?: string; l2Pulled?: number; l2CellsPulled?: number; devices?: number }));
    if (!l2Res.ok || l2Data.success === false) {
      return { l2Pulled: 0, l2CellsPulled: 0, l2Error: l2Data.error || `L2 pull HTTP ${l2Res.status}` };
    }
    return { l2Pulled: l2Data.l2Pulled || l2Data.devices || 0, l2CellsPulled: l2Data.l2CellsPulled || 0, l2Error: null };
  } catch (e) {
    console.warn(`${mcmTag(subsystemId)}[MCM ${subsystemId} Pull] L2 pull failed:`, e instanceof Error ? e.message : e);
    return { l2Pulled: 0, l2CellsPulled: 0, l2Error: e instanceof Error ? e.message : String(e) };
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
 * Pull the approved-firmware baseline as part of the scoped MCM pull.
 * BEST-EFFORT: a technician pulling an MCM must still receive IOs and L2 when
 * the firmware endpoint is unavailable — a firmware failure must NEVER fail
 * (or throw out of) the pull. syncFirmwareBaseline() already returns a
 * structured { ok, error } result rather than throwing on the expected
 * failure modes; this wrapper is a last-resort net for anything unexpected.
 */
async function pullFirmwareBaselineBestEffort(): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    return await syncFirmwareBaseline();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    // BLOCK only on rows that can STILL reach the cloud — those represent real
    // pending work a destructive pull would lose. Parked/orphaned rows
    // (DeadLettered=1) are handled below, NOT here.
    if (pendingActive + pendingEStopCheck + pendingGuidedTask > 0) {
      const parts: string[] = [];
      if (pendingActive > 0) parts.push(`sync ${pendingActive} IO test change(s) first`);
      if (pendingEStopCheck > 0) parts.push(`sync ${pendingEStopCheck} E-stop check result(s) first`);
      if (pendingGuidedTask > 0) parts.push(`sync ${pendingGuidedTask} guided-task update(s) first`);
      return res.status(409).json({
        success: false,
        error: `Pull blocked to protect unsynced local data for subsystem ${subsystemId}: ${parts.join('; ')}.`,
      });
    }

    // Rows the cloud PERMANENTLY rejected (DeadLettered=1 — "parked" needs-a-human
    // + "orphaned" removed-on-cloud) can NEVER sync. The old guard blocked the
    // pull on them too, which WEDGED it forever after a cloud-side device
    // deletion (MCM11) and disagreed with the Sync Center, which triages orphaned
    // rows as soft/"auto-restoring" — so "Sync Center clean" and "pull blocked by
    // N flagged rows" contradicted each other. A destructive pull supersedes them
    // anyway (it rewrites this subsystem's IO table below, under a fresh backup),
    // so CLEAR them here — queue-row-only (never touches Ios/L2/TestHistories),
    // logged to backups/ — instead of blocking. This guarantees the invariant
    // "Sync Center clean ⟺ pull runs". Reuses the same data-safe Sync Center
    // functions the operator's manual Discard uses.
    if (pendingParked > 0) {
      try {
        const deadRefs = [
          ...selectRefs({ allParked: true, subsystemId }),
          ...selectRefs({ allOrphaned: true, subsystemId }),
        ];
        if (deadRefs.length) {
          const snap = snapshotRefs(deadRefs);
          try {
            writeDiscardLog(snap, {
              action: 'auto-clear before pull (cloud-rejected / removed-on-cloud — can never sync)',
              scope: `MCM ${subsystemId}`,
            });
          } catch (logErr) {
            console.warn(`${mcmTag(subsystemIdStr)}[MCM ${subsystemId} Pull] discard-log write failed (proceeding):`, logErr instanceof Error ? logErr.message : logErr);
          }
          const { affected } = discard(deadRefs);
          console.warn(
            `${mcmTag(subsystemIdStr)}[MCM ${subsystemId} Pull] auto-cleared ${affected} cloud-rejected/orphaned queue row(s) ` +
            'that can never sync — they no longer block the pull (queue-only; local data untouched).',
          );
        }
      } catch (clearErr) {
        // Never let queue cleanup abort the pull — the pull's own backup is the
        // safety net, and a leftover dead row is harmless to the pull itself.
        console.warn(`${mcmTag(subsystemIdStr)}[MCM ${subsystemId} Pull] auto-clear of dead queue rows failed (non-fatal):`, clearErr instanceof Error ? clearErr.message : clearErr);
      }
    }

    const cloudUrl = `${remoteUrl}/api/sync/subsystem/${subsystemId}`;
    console.log(`${mcmTag(subsystemIdStr)}[MCM ${subsystemIdStr} Pull] GET ${cloudUrl}`);

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
        console.warn(`${mcmTag(subsystemIdStr)}[MCM ${subsystemIdStr} Pull] attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
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
    // plannedDate is cloud-owned and written WITHOUT a version bump, so it must
    // be hashed explicitly — otherwise a date-only change reads as "no changes"
    // and a manual pull never refreshes it.
    const versionHash = cloudIos
      .map((io: { id: number; version?: number; result?: string; plannedDate?: string | null }) =>
        `${io.id}:${io.version ?? 0}:${io.result || '-'}:${io.plannedDate || '-'}`)
      .join('|');
    if (!force && pullHashStore.get(subsystemId) === versionHash) {
      // IO set unchanged → skip the destructive IO backup + delete/reinsert
      // (the MCM11 churn protection). But STILL refresh the config/FV sections:
      // network/estop/safety/L2 changes on the cloud do NOT move the IO hash, so
      // before this they were skipped here too and only reached the field after a
      // service restart cleared this in-memory hash. runConfigSidePulls is a
      // scoped, idempotent delete+reinsert per section, so this is safe.
      const side = await runConfigSidePulls(subsystemId, remoteUrl, apiPassword, { db });
      const l2 = await pullL2SelfCall(subsystemId, remoteUrl, apiPassword);
      // Even on a no-op (IO set unchanged), the extra sections can have moved on
      // the cloud — refresh them too so a manual pull is never partially stale.
      const extra = await pullExtraSections(subsystemId, remoteUrl, apiPassword);
      // Best-effort: a firmware-baseline failure must never fail this pull —
      // the technician still needs their IOs and L2 when the firmware endpoint
      // is unavailable.
      const firmwareBaseline = await pullFirmwareBaselineBestEffort();
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
        l2Pulled: l2.l2Pulled,
        firmwareBaseline,
        ...extra,
      });
    }

    // ── Destructive core (SHARED with the legacy /api/cloud/pull) ─────────
    // Risk guard → pre-pull backup → scoped DELETE+upsert (WITH the in-txn
    // TOCTOU re-check) → TestHistories → tagType backfill → >50% warning →
    // config side-pulls + L2, all in lib/cloud/pull-core.ts. `global: false`
    // preserves every per-MCM guarantee: `DELETE FROM Ios WHERE SubsystemId=?`,
    // the in-transaction pending re-check that aborts if a test slipped in
    // during the fetch, and subsystem-scoped history/backfill/count queries.
    //
    // Forwarding cloudData.testHistories is what gives this scoped pull the
    // TestHistories sync + classifyDescription tagType backfill + >50%-fewer-IOs
    // warning it previously LACKED (the divergence this refactor fixes). Its
    // TestHistories DELETE is scoped to this subsystem's IOs so other MCMs'
    // audit trails are never touched.
    const cloudHistories = cloudData.testHistories || [];
    const pull = await runFullPull({
      db,
      subsystemId,
      global: false,
      cloudIos,
      cloudHistories,
      remoteUrl,
      apiPassword,
      force,
      isBackground,
      subsystemName: mcm.name || `Subsystem ${subsystemId}`,
      logPrefix: `${mcmTag(subsystemIdStr)}[MCM ${subsystemIdStr} Pull]`,
      deps: { createBackup, extractDeviceName, pullL2: pullL2SelfCall },
    });

    if (pull.kind !== 'ok') {
      if (pull.kind === 'refuse') {
        return res.status(pull.status).json(pull.body);
      }
      if (pull.kind === 'backup-failed') {
        return res.status(500).json({
          success: false,
          error:
            'Pre-pull safety backup failed, so the pull was aborted to protect your local data. ' +
            'Check disk space / backups folder permissions and try again.',
        });
      }
      // TOCTOU re-check tripped inside the transaction: a test was recorded for
      // this MCM during the cloud fetch. Nothing destructive ran; local wins.
      return res.status(409).json({
        success: false,
        error:
          'Pull skipped — a test was recorded for this MCM during the pull. ' +
          'Local data is preserved; the next safety pull will reconcile.',
      });
    }

    const result = pull.iosCount;
    const { networkPulled, estopPulled, safetyPulled, punchlistsPulled, l2Pulled } = pull;
    // Sections runConfigSidePulls / L2 don't cover (VFD blockers/addressed,
    // roadmap, MCM diagram) — refresh them so one manual pull is complete.
    const extra = await pullExtraSections(subsystemId, remoteUrl, apiPassword);
    // Best-effort: a firmware-baseline failure must never fail this pull — the
    // technician still needs their IOs and L2 when the firmware endpoint is
    // unavailable.
    const firmwareBaseline = await pullFirmwareBaselineBestEffort();

    // Invalidate the registry's IO→Subsystem lookup cache so per-IO routing
    // picks up the new rows immediately.
    invalidateIoSubsystemCache();

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

    console.log(`${mcmTag(subsystemIdStr)}[MCM ${subsystemIdStr} Pull] DONE — ios=${result}, network=${networkPulled}, estop=${estopPulled}, safety=${safetyPulled}, punchlists=${punchlistsPulled}`);

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
      firmwareBaseline,
      ...extra,
    });
  } catch (error) {
    console.error(`${mcmTag(subsystemIdStr)}[MCM ${subsystemIdStr} Pull] error:`, error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
