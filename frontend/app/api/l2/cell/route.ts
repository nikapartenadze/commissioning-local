import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { getWsBroadcastUrl } from '@/lib/plc-client-manager'

const stmts = {
  getCell: db.prepare('SELECT id, Value, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
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
}

export async function POST(req: Request, res: Response) {
  try {
    const { deviceId, columnId, value, updatedBy } = req.body

    if (!deviceId || !columnId) {
      return res.status(400).json({ error: 'deviceId and columnId required' })
    }

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

    // Fan out the local change to every connected browser via the
    // /broadcast → /ws bridge, BEFORE the cloud round-trip. This mirrors
    // how /api/ios/:id/test works and means a tech on one tab and a
    // mechanic on another see the same Belt Tracked / FV cell value
    // within milliseconds, not after the cloud SSE echo.
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'L2CellUpdated',
          cloudDeviceId: result.cloudDeviceId ?? 0,
          cloudColumnId: result.cloudColumnId ?? 0,
          localDeviceId: deviceId,
          localColumnId: columnId,
          value: value ?? null,
          version: result.version,
          updatedBy: updatedBy ?? null,
          updatedAt: new Date().toISOString(),
        }),
      })
    } catch {
      // Broadcast is best-effort — sibling browsers will pick up the
      // change on their next /api/cloud/status poll or SSE echo.
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

        // Conflict (or unknown shape) — leave pendingSync, background sync will retry
        console.warn(`[L2 Sync] Push for device ${cloudDeviceId} col ${cloudColumnId} not in updates response — leaving pendingSync for background retry`)
      })
    }

    return res.json({ success: true, cellId: result.cellId, version: result.version, completedChecks: result.completedChecks })
  } catch (error) {
    console.error('[L2 Cell] Error:', error)
    return res.status(500).json({ error: 'Failed to save cell' })
  }
}
