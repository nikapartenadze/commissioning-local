import { Request, Response } from 'express';
import { db, extractDeviceName } from '@/lib/db-sqlite';
import { configService } from '@/lib/config';
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types';
import { invalidateIoSubsystemCache } from '@/lib/mcm-registry';
import { getWsBroadcastUrl } from '@/lib/plc-client-manager';

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

  try {
    const cfg = await configService.getConfig();
    const mcm = await configService.getMcm(subsystemIdStr);
    if (!mcm) {
      return res.status(404).json({ success: false, error: `MCM ${subsystemIdStr} not configured` });
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
    const pendingIo = (db
      .prepare(
        `SELECT COUNT(*) as cnt FROM PendingSyncs ps
         JOIN Ios i ON i.id = ps.IoId
         WHERE i.SubsystemId = ?`,
      )
      .get(subsystemId) as { cnt: number }).cnt;
    if (pendingIo > 0) {
      return res.status(409).json({
        success: false,
        error: `Pull blocked: ${pendingIo} IO test changes for subsystem ${subsystemId} are awaiting cloud sync. Sync first.`,
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

    const result = db.transaction(() => {
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

    console.log(`[MCM ${subsystemIdStr} Pull] DONE — ios=${result}, network=${networkPulled}, estop=${estopPulled}, punchlists=${punchlistsPulled}`);
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
