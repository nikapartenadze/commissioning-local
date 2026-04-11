import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

const stmts = {
  getCell: db.prepare('SELECT id, Value, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
  updateCell: db.prepare(`UPDATE L2CellValues SET Value = ?, UpdatedBy = ?, UpdatedAt = datetime('now'), Version = ? WHERE id = ?`),
  insertCell: db.prepare(`INSERT INTO L2CellValues (DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, datetime('now'), ?)`),
  getDeviceCloudId: db.prepare('SELECT CloudId FROM L2Devices WHERE id = ?'),
  getColumnCloudId: db.prepare('SELECT CloudId FROM L2Columns WHERE id = ?'),
  insertPendingSync: db.prepare('INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version) VALUES (?, ?, ?, ?, ?)'),
  getCheckColumns: db.prepare(`SELECT id FROM L2Columns WHERE SheetId = (SELECT SheetId FROM L2Devices WHERE id = ?) AND ColumnType = 'check'`),
  countCompleted: db.prepare(`SELECT COUNT(*) as cnt FROM L2CellValues cv JOIN L2Columns lc ON cv.ColumnId = lc.id WHERE cv.DeviceId = ? AND lc.ColumnType = 'check' AND cv.Value IS NOT NULL AND cv.Value != ''`),
  updateDeviceChecks: db.prepare('UPDATE L2Devices SET CompletedChecks = ? WHERE id = ?'),
  deletePendingSync: db.prepare('DELETE FROM L2PendingSyncs WHERE id = ?'),
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

    if (result.cloudDeviceId && result.cloudColumnId) {
      tryInstantL2Push(result.cloudDeviceId, result.cloudColumnId, value ?? null, result.version - 1, updatedBy, result.pendingSyncId)
    }

    return res.json({ success: true, cellId: result.cellId, version: result.version, completedChecks: result.completedChecks })
  } catch (error) {
    console.error('[L2 Cell] Error:', error)
    return res.status(500).json({ error: 'Failed to save cell' })
  }
}

async function tryInstantL2Push(cloudDeviceId: number, cloudColumnId: number, value: string | null, version: number, updatedBy: string | null, pendingSyncId: number | null) {
  const MAX_ATTEMPTS = 3

  try {
    const config = await configService.getConfig()
    if (!config.remoteUrl) return

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(`${config.remoteUrl}/api/sync/l2/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiPassword || '' },
          body: JSON.stringify({ updates: [{ deviceId: cloudDeviceId, columnId: cloudColumnId, value, version, updatedBy: updatedBy || 'unknown' }] }),
          signal: AbortSignal.timeout(10000),
        })

        if (resp.ok) {
          // Parse the response — cloud returns 200 even on conflicts
          const data = await resp.json().catch(() => null) as any
          const wasUpdated = data?.updates?.some((u: any) => u.deviceId === cloudDeviceId && u.columnId === cloudColumnId)
          const wasConflict = data?.conflicts?.some((c: any) => c.deviceId === cloudDeviceId && c.columnId === cloudColumnId)

          if (wasUpdated) {
            // Successfully updated — delete pendingSync
            if (pendingSyncId) { try { stmts.deletePendingSync.run(pendingSyncId) } catch {} }
            return
          }

          if (wasConflict) {
            // Version conflict — leave pendingSync for background retry.
            // The background sync will re-read the latest local state and retry.
            console.warn(`[L2 Sync] Version conflict for device ${cloudDeviceId} col ${cloudColumnId} — will retry via background sync`)
            return
          }

          // Unknown response shape — treat as success to avoid infinite retry
          if (pendingSyncId) { try { stmts.deletePendingSync.run(pendingSyncId) } catch {} }
          return
        }

        if (resp.status === 401) {
          console.warn(`[L2 Sync] Auth failure (401) pushing device ${cloudDeviceId} col ${cloudColumnId} — skipping retries`)
          return
        }

        console.warn(`[L2 Sync] Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (HTTP ${resp.status}) for device ${cloudDeviceId} col ${cloudColumnId}`)
      } catch (err) {
        console.warn(`[L2 Sync] Attempt ${attempt + 1}/${MAX_ATTEMPTS} error for device ${cloudDeviceId} col ${cloudColumnId}:`, err instanceof Error ? err.message : err)
      }

      // Exponential backoff: 1s, 2s between retries
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
      }
    }

    console.warn(`[L2 Sync] All ${MAX_ATTEMPTS} attempts exhausted for device ${cloudDeviceId} col ${cloudColumnId} — background sync will retry`)
  } catch (err) {
    console.warn('[L2 Sync] Unexpected error in instant push:', err instanceof Error ? err.message : err)
  }
}
