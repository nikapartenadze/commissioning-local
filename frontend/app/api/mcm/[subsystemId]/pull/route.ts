import { Request, Response } from 'express';
import { db, extractDeviceName } from '@/lib/db-sqlite';
import { configService } from '@/lib/config';
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types';
import { invalidateIoSubsystemCache, getMcmStatus } from '@/lib/mcm-registry';
import { getWsBroadcastUrl } from '@/lib/plc-client-manager';
import { createBackup } from '@/lib/db/backup';
import { computeAtRiskResults, computeAtRiskComments } from '@/lib/cloud/pull-guard';
import { auditLog } from '@/lib/logging/recovery-log';

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
    if (pendingActive + pendingParked > 0) {
      const parts: string[] = [];
      if (pendingActive > 0) parts.push(`sync ${pendingActive} IO test change(s) first`);
      if (pendingParked > 0) {
        parts.push(
          `resolve ${pendingParked} flagged row(s) the cloud rejected ` +
          '(re-pass/fail/clear or accept in the grid — these cannot be synced)',
        );
      }
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
      return res.json({
        success: true,
        unchanged: true,
        message: `No changes for MCM ${mcm.name} — skipped backup + rewrite`,
        iosCount: cloudIos.length,
        subsystemId,
      });
    }

    // B6 (mirrors legacy /api/cloud/pull): the rewrite below is DESTRUCTIVE
    // (scoped DELETE FROM Ios + reinsert cloud state). The pre-pull backup is
    // the last line of recovery — if it fails, ABORT rather than wipe with no
    // safety net. Taken AFTER the no-op check above so unchanged cycles don't
    // generate backups, but still BEFORE any delete.
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

    // ── Result-loss guard (2026-06-04 TPA8/MCM08 incident) ──────────────
    // Same second line of defense as the legacy /api/cloud/pull, scoped to
    // this subsystem: the pending-queue check above failed catastrophically
    // when the retry cap silently emptied the queue, so this guard ignores
    // the queue and compares actual local results/comments against the
    // actual cloud payload. Override requires an explicit body.force after
    // user confirmation in the UI.
    const localWithResults = db.prepare(
      `SELECT id, Name, Result FROM Ios WHERE SubsystemId = ? AND Result IS NOT NULL AND Result != ''`,
    ).all(subsystemId) as Array<{ id: number; Name: string; Result: string }>;
    const atRisk = computeAtRiskResults(localWithResults, cloudIos);
    const localWithComments = db.prepare(
      `SELECT id, Name, Comments FROM Ios WHERE SubsystemId = ? AND Comments IS NOT NULL AND TRIM(Comments) != ''`,
    ).all(subsystemId) as Array<{ id: number; Name: string; Comments: string }>;
    const atRiskComments = computeAtRiskComments(localWithComments, cloudIos);

    if ((atRisk.length > 0 || atRiskComments.length > 0) && !force) {
      console.warn(
        `[MCM ${subsystemIdStr} Pull] REFUSED: pull would erase ${atRisk.length} local result(s) ` +
        `and ${atRiskComments.length} local comment(s) the cloud does not have ` +
        `(e.g. ${atRisk.slice(0, 5).map((r) => `${r.name}=${r.result}`).join(', ')}). ` +
        'Resend with force=true to override.',
      );
      const parts = [
        atRisk.length > 0 ? `${atRisk.length} test result(s)` : null,
        atRiskComments.length > 0 ? `${atRiskComments.length} comment(s)` : null,
      ].filter(Boolean).join(' and ');
      return res.status(409).json({
        success: false,
        requiresForce: true,
        wouldLoseResults: atRisk.length,
        wouldLoseComments: atRiskComments.length,
        atRiskSample: atRisk.slice(0, 10),
        atRiskCommentSample: atRiskComments.slice(0, 10),
        error:
          `Pull refused: ${parts} exist locally for MCM ${subsystemId} that the cloud does not have — ` +
          'pulling now would erase them. They are likely unsynced field work. ' +
          'Sync first, or confirm the overwrite to proceed. (A pre-pull backup is taken regardless.)',
      });
    }
    if (atRisk.length > 0 || atRiskComments.length > 0) {
      console.warn(
        `[MCM ${subsystemIdStr} Pull] FORCE override: erasing ${atRisk.length} result(s) + ` +
        `${atRiskComments.length} comment(s) not present on cloud (user confirmed)`,
      );
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
      if (pendingNow > 0) {
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

      // Scoped clears for related per-subsystem data.
      db.prepare(`
        DELETE FROM EStopIoPoints WHERE EpcId IN (
          SELECT id FROM EStopEpcs WHERE ZoneId IN (
            SELECT id FROM EStopZones WHERE SubsystemId = ?
          )
        )
      `).run(subsystemId);
      db.prepare(`
        DELETE FROM EStopVfds WHERE EpcId IN (
          SELECT id FROM EStopEpcs WHERE ZoneId IN (
            SELECT id FROM EStopZones WHERE SubsystemId = ?
          )
        )
      `).run(subsystemId);
      db.prepare(`
        DELETE FROM EStopEpcs WHERE ZoneId IN (
          SELECT id FROM EStopZones WHERE SubsystemId = ?
        )
      `).run(subsystemId);
      db.prepare('DELETE FROM EStopZones WHERE SubsystemId = ?').run(subsystemId);
      db.prepare(`
        DELETE FROM SafetyZoneDrives WHERE ZoneId IN (
          SELECT id FROM SafetyZones WHERE SubsystemId = ?
        )
      `).run(subsystemId);
      db.prepare('DELETE FROM SafetyZones WHERE SubsystemId = ?').run(subsystemId);
      db.prepare('DELETE FROM SafetyOutputs WHERE SubsystemId = ?').run(subsystemId);
      db.prepare(`
        DELETE FROM NetworkPorts WHERE NodeId IN (
          SELECT id FROM NetworkNodes WHERE RingId IN (
            SELECT id FROM NetworkRings WHERE SubsystemId = ?
          )
        )
      `).run(subsystemId);
      db.prepare(`
        DELETE FROM NetworkNodes WHERE RingId IN (
          SELECT id FROM NetworkRings WHERE SubsystemId = ?
        )
      `).run(subsystemId);
      db.prepare('DELETE FROM NetworkRings WHERE SubsystemId = ?').run(subsystemId);
      db.prepare(`
        DELETE FROM PunchlistItems WHERE PunchlistId IN (
          SELECT id FROM Punchlists WHERE SubsystemId = ?
        )
      `).run(subsystemId);
      db.prepare('DELETE FROM Punchlists WHERE SubsystemId = ?').run(subsystemId);

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
    let networkPulled = 0;
    let estopPulled = 0;
    let punchlistsPulled = 0;
    let l2Pulled = 0;

    try {
      const netRes = await fetch(`${remoteUrl}/api/network?subsystemId=${subsystemId}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (netRes.ok) {
        const netData = await netRes.json();
        if (netData.success && netData.rings?.length > 0) {
          const insertRing = db.prepare(
            'INSERT INTO NetworkRings (SubsystemId, Name, McmName, McmIp, McmTag) VALUES (?, ?, ?, ?, ?)',
          );
          const insertNode = db.prepare(
            'INSERT INTO NetworkNodes (RingId, Name, Position, IpAddress, CableIn, CableOut, StatusTag, TotalPorts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          );
          const insertPort = db.prepare(
            'INSERT INTO NetworkPorts (NodeId, PortNumber, CableLabel, DeviceName, DeviceType, DeviceIp, StatusTag, ParentPortId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          );
          for (const ring of netData.rings) {
            const rr = insertRing.run(subsystemId, ring.name, ring.mcmName, ring.mcmIp || null, ring.mcmTag || null);
            const ringId = rr.lastInsertRowid;
            for (const node of ring.nodes || []) {
              const nr = insertNode.run(
                ringId, node.name, node.position, node.ipAddress || null,
                node.cableIn || null, node.cableOut || null, node.statusTag || null, node.totalPorts || 28,
              );
              const nodeId = nr.lastInsertRowid;
              for (const port of node.ports || []) {
                insertPort.run(
                  nodeId, port.portNumber, port.cableLabel || null,
                  port.deviceName || null, port.deviceType || null, port.deviceIp || null,
                  port.statusTag || null, null,
                );
              }
            }
          }
          networkPulled = netData.rings.length;
        }
      }
    } catch (e) {
      console.warn(`[MCM ${subsystemIdStr} Pull] network pull failed:`,
        e instanceof Error ? e.message : e);
    }

    try {
      const estopRes = await fetch(`${remoteUrl}/api/sync/estop?subsystemId=${subsystemId}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (estopRes.ok) {
        const estopData = await estopRes.json();
        if (estopData.success && estopData.zones?.length > 0) {
          const insertZone = db.prepare('INSERT INTO EStopZones (SubsystemId, Name) VALUES (?, ?)');
          const insertEpc = db.prepare('INSERT INTO EStopEpcs (ZoneId, Name, CheckTag) VALUES (?, ?, ?)');
          const insertIoPoint = db.prepare('INSERT INTO EStopIoPoints (EpcId, Tag) VALUES (?, ?)');
          const insertVfd = db.prepare(
            'INSERT INTO EStopVfds (EpcId, Tag, StoTag, MustStop) VALUES (?, ?, ?, ?)',
          );
          for (const zone of estopData.zones) {
            const zr = insertZone.run(subsystemId, zone.name);
            const zoneId = zr.lastInsertRowid;
            for (const epc of zone.epcs || []) {
              const er = insertEpc.run(zoneId, epc.name, epc.checkTag);
              const epcId = er.lastInsertRowid;
              for (const io of epc.ioPoints || []) insertIoPoint.run(epcId, io.tag);
              for (const vfd of epc.vfds || []) insertVfd.run(epcId, vfd.tag, vfd.stoTag, vfd.mustStop ? 1 : 0);
            }
          }
          estopPulled = estopData.zones.length;
        }
      }
    } catch (e) {
      console.warn(`[MCM ${subsystemIdStr} Pull] estop pull failed:`,
        e instanceof Error ? e.message : e);
    }

    try {
      const plRes = await fetch(`${remoteUrl}/api/sync/punchlists?subsystemId=${subsystemId}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (plRes.ok) {
        const plData = await plRes.json();
        if (plData.punchlists?.length > 0) {
          const insertPunchlist = db.prepare(
            'INSERT OR REPLACE INTO Punchlists (id, Name, SubsystemId) VALUES (?, ?, ?)',
          );
          const insertItem = db.prepare(
            'INSERT OR IGNORE INTO PunchlistItems (PunchlistId, IoId) VALUES (?, ?)',
          );
          for (const pl of plData.punchlists) {
            insertPunchlist.run(pl.id, pl.name, subsystemId);
            for (const ioId of pl.ioIds || []) insertItem.run(pl.id, ioId);
            punchlistsPulled++;
          }
        }
      }
    } catch (e) {
      console.warn(`[MCM ${subsystemIdStr} Pull] punchlist pull failed:`,
        e instanceof Error ? e.message : e);
    }

    // L2 pull intentionally skipped here — L2Sheets/Columns are global to the
    // project, and replacing them would clobber other MCMs' setups. The
    // legacy /api/cloud/pull-l2 endpoint owns that flow and should be called
    // once per project, not per MCM.

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

    console.log(`[MCM ${subsystemIdStr} Pull] DONE — ios=${result}, network=${networkPulled}, estop=${estopPulled}, punchlists=${punchlistsPulled}`);

    // Durable recovery-log trace of this DESTRUCTIVE pull (the no-op short-
    // circuit above rewrote nothing and is intentionally not logged). Log-only.
    auditLog({
      type: 'sync.pull',
      subsystemId,
      detail: {
        iosCount: result,
        networkPulled,
        estopPulled,
      },
    });

    return res.json({
      success: true,
      subsystemId,
      message: `Pulled ${result} IOs for MCM ${mcm.name}`,
      iosCount: result,
      networkPulled,
      estopPulled,
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
