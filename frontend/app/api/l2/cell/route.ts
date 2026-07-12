import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { auditLog } from '@/lib/logging/recovery-log'

const stmts = {
  getCell: db.prepare('SELECT id, Value, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
  getDeviceSubsystem: db.prepare('SELECT SubsystemId FROM L2Devices WHERE id = ?'),
  getColumnExists: db.prepare('SELECT id FROM L2Columns WHERE id = ?'),
  updateCell: db.prepare(`UPDATE L2CellValues SET Value = ?, UpdatedBy = ?, UpdatedAt = datetime('now'), Version = ? WHERE id = ?`),
  insertCell: db.prepare(`INSERT INTO L2CellValues (DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, datetime('now'), ?)`),
  getDeviceCloudId: db.prepare('SELECT CloudId FROM L2Devices WHERE id = ?'),
  getColumnCloudId: db.prepare('SELECT CloudId FROM L2Columns WHERE id = ?'),
  insertPendingSync: db.prepare('INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version) VALUES (?, ?, ?, ?, ?)'),
  countCompleted: db.prepare(`SELECT COUNT(*) as cnt FROM L2CellValues cv JOIN L2Columns lc ON cv.ColumnId = lc.id WHERE cv.DeviceId = ? AND lc.IncludeInProgress = 1 AND cv.Value IS NOT NULL AND cv.Value != ''`),
  updateDeviceChecks: db.prepare('UPDATE L2Devices SET CompletedChecks = ? WHERE id = ?'),
  deletePendingSync: db.prepare('DELETE FROM L2PendingSyncs WHERE id = ?'),
  deleteAllPendingForCell: db.prepare('DELETE FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ?'),
  getCellForPush: db.prepare('SELECT Value, Version, UpdatedBy FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
  getLatestPendingForCell: db.prepare('SELECT id FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ? ORDER BY id DESC LIMIT 1'),
  // Get the OLDEST pending sync version for a cell — this is the version the cloud actually has
  getOldestPendingVersion: db.prepare('SELECT MIN(Version) as version FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ?'),
  // Rebase pending rows for a cell against the cloud's current version so the
  // next retry's base version matches what cloud actually has. Increments
  // RetryCount so the 10-strike cap still fires on rows that can't resolve —
  // earlier code reset it to 0 which created a livelock that permanently
  // blocked the /api/cloud/pull endpoint (totalPendingCount > 0 → 409). See
  // v2.27 regression report for the full story.
  rebasePendingForCell: db.prepare(
    `UPDATE L2PendingSyncs SET Version = ?, RetryCount = RetryCount + 1, LastError = ? WHERE CloudDeviceId = ? AND CloudColumnId = ?`
  ),
}

export async function POST(req: Request, res: Response) {
  try {
    const { deviceId, columnId, value, updatedBy } = req.body

    if (!deviceId || !columnId) {
      // Failure audits mirror the success-path l2.cell entry: the 2026-07-11
      // MCM04 loss was 114 rejected saves that left NO durable trace — the
      // rejected VALUE goes into detail so it is recoverable from this log.
      auditLog({
        type: 'l2.cell.fail',
        user: updatedBy ?? null,
        reason: '400 deviceId and columnId required',
        detail: { deviceId: deviceId ?? null, columnId: columnId ?? null, value: value ?? null },
      })
      return res.status(400).json({ error: 'deviceId and columnId required' })
    }

    // Existence guard (F4): reject an unknown device/column instead of inserting
    // an orphan cell. This is the case where a queued outbox edit is replayed
    // after a pull renumbered the local ids — the id no longer maps to a device.
    // 404 lets the client's bounded replay eventually evict it rather than
    // silently writing to a wrong/nonexistent cell.
    const deviceRow = stmts.getDeviceSubsystem.get(deviceId) as { SubsystemId: number | null } | undefined
    const columnRow = stmts.getColumnExists.get(columnId) as { id: number } | undefined
    if (!deviceRow || !columnRow) {
      auditLog({
        type: 'l2.cell.fail',
        user: updatedBy ?? null,
        reason: '404 stale local id — L2 device/column not found, cell not written',
        detail: { deviceId, columnId, value: value ?? null, deviceFound: !!deviceRow, columnFound: !!columnRow },
      })
      return res.status(404).json({ success: false, error: 'L2 device/column not found (stale local id?) — cell not written' })
    }
    // Resolve the subsystem BEFORE the commit so the audit is accurate even if a
    // concurrent pull races the write (F11).
    const subsystemId = deviceRow.SubsystemId ?? null

    const result = db.transaction(() => {
      const existing = stmts.getCell.get(deviceId, columnId) as { id: number; Value: string | null; Version: number } | undefined
      let cellId: number, newVersion: number

      if (existing) {
        newVersion = existing.Version + 1
        stmts.updateCell.run(value ?? null, updatedBy ?? null, newVersion, existing.id)
        cellId = existing.id
      } else {
        newVersion = 1
        const insertResult = stmts.insertCell.run(deviceId, columnId, value ?? null, updatedBy ?? null, newVersion)
        cellId = insertResult.lastInsertRowid as number
      }

      const device = stmts.getDeviceCloudId.get(deviceId) as { CloudId: number } | undefined
      const column = stmts.getColumnCloudId.get(columnId) as { CloudId: number } | undefined

      let pendingSyncId: number | null = null
      if (device?.CloudId && column?.CloudId) {
        const syncResult = stmts.insertPendingSync.run(device.CloudId, column.CloudId, value ?? null, updatedBy ?? null, newVersion - 1)
        pendingSyncId = syncResult.lastInsertRowid as number
      }

      const completedCount = stmts.countCompleted.get(deviceId) as { cnt: number }
      stmts.updateDeviceChecks.run(completedCount?.cnt || 0, deviceId)

      return { cellId, version: newVersion, completedChecks: completedCount?.cnt || 0, cloudDeviceId: device?.CloudId, cloudColumnId: column?.CloudId, pendingSyncId }
    })()

    // Journal the FV write to the durable recovery log BEFORE anything can wipe
    // it — this is the local audit trail that lets lost FV work be reconstructed
    // (mirrors io.test for IO results). auditLog never throws.
    auditLog({
      type: 'l2.cell',
      subsystemId,
      user: updatedBy ?? null,
      version: result.version,
      detail: { deviceId, columnId, cloudDeviceId: result.cloudDeviceId ?? null, cloudColumnId: result.cloudColumnId ?? null, value: value ?? null },
    })

    // A cell with no cloud mapping is durable locally but can NEVER sync — record
    // it as a drop so it is not a silent cloud-desync (the F4 gap).
    if (!result.cloudDeviceId || !result.cloudColumnId) {
      auditLog({
        type: 'l2.push.drop',
        subsystemId,
        user: updatedBy ?? null,
        version: result.version,
        reason: 'unmapped: L2 device/column has no CloudId — cannot sync to cloud',
        detail: { deviceId, columnId, value: value ?? null },
      })
    }

    if (result.cloudDeviceId && result.cloudColumnId) {
      const cloudDeviceId = result.cloudDeviceId
      const cloudColumnId = result.cloudColumnId
      const key = `l2cell:${deviceId}-${columnId}`

      enqueueSyncPush(key, async () => {
        // Read the LATEST local value (handles rapid edits — always push final value)
        const cell = stmts.getCellForPush.get(deviceId, columnId) as { Value: string | null; Version: number; UpdatedBy: string | null } | undefined
        if (!cell) return

        // Use the OLDEST pending sync version as the base — this is what the cloud
        // actually has. DO NOT use cell.Version - 1, because if multiple people edited
        // this cell while the first push was in-flight (slow network), local version
        // jumps ahead and cell.Version - 1 won't match the cloud's actual version.
        const oldestPending = stmts.getOldestPendingVersion.get(cloudDeviceId, cloudColumnId) as { version: number | null } | undefined
        const baseVersion = oldestPending?.version ?? (cell.Version - 1)

        const config = await configService.getConfig()
        if (!config.remoteUrl) return

        let resp: globalThis.Response
        try {
          resp = await fetch(`${config.remoteUrl}/api/sync/l2/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiPassword || '' },
            body: JSON.stringify({
              updates: [{
                deviceId: cloudDeviceId,
                columnId: cloudColumnId,
                value: cell.Value,
                version: baseVersion,
                updatedBy: cell.UpdatedBy || 'unknown',
              }],
            }),
            signal: AbortSignal.timeout(10000),
          })
        } catch (err) {
          // Network error / timeout — background sync will retry
          console.warn(`[L2 Sync] Network error pushing device ${cloudDeviceId} col ${cloudColumnId}:`, err instanceof Error ? err.message : err)
          return
        }

        if (resp.status === 401) {
          console.warn(`[L2 Sync] Auth failure (401) pushing device ${cloudDeviceId} col ${cloudColumnId}`)
          return
        }

        if (!resp.ok) {
          console.warn(`[L2 Sync] HTTP ${resp.status} pushing device ${cloudDeviceId} col ${cloudColumnId} — background sync will retry`)
          return
        }

        const data = await resp.json().catch(() => null) as any
        const wasUpdated = data?.updates?.some((u: any) => u.deviceId === cloudDeviceId && u.columnId === cloudColumnId)

        if (wasUpdated) {
          // Track this push so the SSE echo from cloud doesn't get re-applied locally
          try {
            const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
            getCloudSseClient()?.trackPushedL2Id(cloudDeviceId, cloudColumnId)
          } catch (e) { console.warn('[L2 SSE] trackPushedL2Id failed:', e) }

          // Cloud accepted our update — drop ALL pendingSync rows for this cell
          // (not just the latest — all intermediate rows are now stale)
          try {
            stmts.deleteAllPendingForCell.run(cloudDeviceId, cloudColumnId)
          } catch (err) {
            console.warn(`[L2 Sync] Failed to clear pendingSyncs for device ${cloudDeviceId} col ${cloudColumnId}:`, err instanceof Error ? err.message : err)
          }
          return
        }

        // Cloud reported a version conflict with the cloud's current version. Rebase the
        // pending row(s) to that version so the next retry's base matches. Cloud's
        // protocol treats "same value, any version" as an idempotent no-op, so the
        // only way to land here is values genuinely differ — local is authoritative
        // per CLAUDE.md, so we want local's value to win on the next attempt.
        const conflict = data?.conflicts?.find?.(
          (c: any) => c.deviceId === cloudDeviceId && c.columnId === cloudColumnId,
        )
        if (conflict && typeof conflict.cloudVersion === 'number') {
          try {
            stmts.rebasePendingForCell.run(conflict.cloudVersion, 'rebased after version conflict', cloudDeviceId, cloudColumnId)
            console.log(`[L2 Sync] Rebased pending for device ${cloudDeviceId} col ${cloudColumnId} to cloud version ${conflict.cloudVersion} — next push will succeed`)
          } catch (err) {
            console.warn(`[L2 Sync] Failed to rebase pending for device ${cloudDeviceId} col ${cloudColumnId}:`, err instanceof Error ? err.message : err)
          }
          return
        }

        // Unknown response shape — leave pendingSync, background sync's retry cap will eventually drop it
        console.warn(`[L2 Sync] Push for device ${cloudDeviceId} col ${cloudColumnId} not in updates response and no conflict info — leaving pendingSync for background retry`)
      })
    }

    return res.json({ success: true, cellId: result.cellId, version: result.version, completedChecks: result.completedChecks })
  } catch (error) {
    console.error('[L2 Cell] Error:', error)
    const body = (req.body ?? {}) as Record<string, unknown>
    auditLog({
      type: 'l2.cell.fail',
      user: (body.updatedBy as string | undefined) ?? null,
      reason: `500 ${error instanceof Error ? error.message : 'unknown error'}`,
      detail: { deviceId: body.deviceId ?? null, columnId: body.columnId ?? null, value: body.value ?? null },
    })
    return res.status(500).json({ error: 'Failed to save cell' })
  }
}
