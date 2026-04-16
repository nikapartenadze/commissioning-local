import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'

/**
 * POST /api/vfd-commissioning/write-l2-cells
 *
 * Writes one or more L2 spreadsheet cells for a specific VFD device.
 * Looks up the L2Devices row by deviceName + sheetId (or sheetName), then resolves
 * each column by name and writes its value. Triggers cloud sync push for each cell.
 *
 * Request body:
 *   {
 *     deviceName: "BYAB_10",        // matches L2Devices.DeviceName
 *     sheetName?: "APF",             // optional: filter by sheet name (DisplayName or Name)
 *     subsystemId?: 16,              // optional: not used for L2 lookup directly
 *     updatedBy: "ASH",
 *     cells: [
 *       { columnName: "Motor HP (Field)", value: "5.0" },
 *       { columnName: "Ready For Tracking", value: "ASH 9/9" }
 *     ]
 *   }
 *
 * Response:
 *   { success: true, written: [{ columnName, ok, error? }] }
 */

const stmts = {
  findDevice: db.prepare(`
    SELECT d.id as deviceId, d.SheetId, s.Name as sheetName, s.DisplayName as sheetDisplayName
    FROM L2Devices d
    JOIN L2Sheets s ON d.SheetId = s.id
    WHERE LOWER(d.DeviceName) = LOWER(?)
  `),
  findColumn: db.prepare(`
    SELECT id, Name, ColumnType, IsEditable
    FROM L2Columns
    WHERE SheetId = ? AND LOWER(TRIM(Name)) = LOWER(TRIM(?))
  `),
  getCell: db.prepare('SELECT id, Value, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
  updateCell: db.prepare(`UPDATE L2CellValues SET Value = ?, UpdatedBy = ?, UpdatedAt = datetime('now'), Version = ? WHERE id = ?`),
  insertCell: db.prepare(`INSERT INTO L2CellValues (DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, datetime('now'), ?)`),
  getDeviceCloudId: db.prepare('SELECT CloudId FROM L2Devices WHERE id = ?'),
  getColumnCloudId: db.prepare('SELECT CloudId FROM L2Columns WHERE id = ?'),
  insertPendingSync: db.prepare('INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version) VALUES (?, ?, ?, ?, ?)'),
  countCompleted: db.prepare(`SELECT COUNT(*) as cnt FROM L2CellValues cv JOIN L2Columns lc ON cv.ColumnId = lc.id WHERE cv.DeviceId = ? AND lc.IncludeInProgress = 1 AND cv.Value IS NOT NULL AND cv.Value != ''`),
  updateDeviceChecks: db.prepare('UPDATE L2Devices SET CompletedChecks = ? WHERE id = ?'),
  getCellForPush: db.prepare('SELECT Value, Version, UpdatedBy FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
  deletePendingSync: db.prepare('DELETE FROM L2PendingSyncs WHERE id = ?'),
  getLatestPendingForCell: db.prepare('SELECT id FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ? ORDER BY id DESC LIMIT 1'),
}

interface CellWrite {
  columnName: string
  value: string | null
}

export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, sheetName, updatedBy, cells } = req.body as {
      deviceName?: string
      sheetName?: string
      updatedBy?: string
      cells?: CellWrite[]
    }

    if (!deviceName || !Array.isArray(cells) || cells.length === 0) {
      return res.status(400).json({ error: 'deviceName and cells[] required' })
    }

    // Find candidate device rows. A VFD might appear in multiple sheets — prefer
    // the one matching sheetName if provided, otherwise take the first APF sheet,
    // otherwise the first match.
    const allMatches = stmts.findDevice.all(deviceName) as Array<{
      deviceId: number; SheetId: number; sheetName: string; sheetDisplayName: string
    }>

    if (allMatches.length === 0) {
      return res.status(404).json({ error: `No L2 device found with name "${deviceName}"` })
    }

    let target = allMatches[0]
    if (sheetName) {
      const wanted = sheetName.toLowerCase().trim()
      const m = allMatches.find(d =>
        (d.sheetName || '').toLowerCase().trim() === wanted ||
        (d.sheetDisplayName || '').toLowerCase().trim() === wanted
      )
      if (m) target = m
    }

    const written: Array<{ columnName: string; ok: boolean; error?: string }> = []
    const cloudPushQueue: Array<{ deviceId: number; columnId: number; cloudDeviceId: number; cloudColumnId: number }> = []

    db.transaction(() => {
      for (const cell of cells) {
        const col = stmts.findColumn.get(target.SheetId, cell.columnName) as {
          id: number; Name: string; IsEditable: number
        } | undefined

        if (!col) {
          written.push({ columnName: cell.columnName, ok: false, error: `Column not found in sheet "${target.sheetName}"` })
          continue
        }

        const existing = stmts.getCell.get(target.deviceId, col.id) as { id: number; Value: string | null; Version: number } | undefined
        let newVersion: number

        if (existing) {
          newVersion = existing.Version + 1
          stmts.updateCell.run(cell.value ?? null, updatedBy ?? null, newVersion, existing.id)
        } else {
          newVersion = 1
          stmts.insertCell.run(target.deviceId, col.id, cell.value ?? null, updatedBy ?? null, newVersion)
        }

        const device = stmts.getDeviceCloudId.get(target.deviceId) as { CloudId: number } | undefined
        const column = stmts.getColumnCloudId.get(col.id) as { CloudId: number } | undefined

        if (device?.CloudId && column?.CloudId) {
          stmts.insertPendingSync.run(device.CloudId, column.CloudId, cell.value ?? null, updatedBy ?? null, newVersion - 1)
          cloudPushQueue.push({
            deviceId: target.deviceId,
            columnId: col.id,
            cloudDeviceId: device.CloudId,
            cloudColumnId: column.CloudId,
          })
        }

        const completedCount = stmts.countCompleted.get(target.deviceId) as { cnt: number }
        stmts.updateDeviceChecks.run(completedCount?.cnt || 0, target.deviceId)

        written.push({ columnName: cell.columnName, ok: true })
      }
    })()

    // Fire cloud sync pushes (best-effort)
    for (const push of cloudPushQueue) {
      const key = `l2cell:${push.deviceId}-${push.columnId}`
      enqueueSyncPush(key, async () => {
        const cell = stmts.getCellForPush.get(push.deviceId, push.columnId) as { Value: string | null; Version: number; UpdatedBy: string | null } | undefined
        if (!cell) return
        const config = await configService.getConfig()
        if (!config.remoteUrl) return

        try {
          const resp = await fetch(`${config.remoteUrl}/api/sync/l2/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiPassword || '' },
            body: JSON.stringify({
              updates: [{
                deviceId: push.cloudDeviceId,
                columnId: push.cloudColumnId,
                value: cell.Value,
                version: cell.Version - 1,
                updatedBy: cell.UpdatedBy || 'unknown',
              }],
            }),
            signal: AbortSignal.timeout(10000),
          })
          if (!resp.ok) return
          const data = await resp.json().catch(() => null) as any
          const wasUpdated = data?.updates?.some((u: any) => u.deviceId === push.cloudDeviceId && u.columnId === push.cloudColumnId)
          if (wasUpdated) {
            try {
              const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
              getCloudSseClient()?.trackPushedL2Id(push.cloudDeviceId, push.cloudColumnId)
            } catch {}
            try {
              const pending = stmts.getLatestPendingForCell.get(push.cloudDeviceId, push.cloudColumnId) as { id: number } | undefined
              if (pending) stmts.deletePendingSync.run(pending.id)
            } catch {}
          }
        } catch (err) {
          console.warn(`[VFD L2 Write] Cloud push failed:`, err instanceof Error ? err.message : err)
        }
      })
    }

    return res.json({
      success: written.every(w => w.ok),
      written,
      sheet: target.sheetName,
      deviceId: target.deviceId,
    })
  } catch (error) {
    console.error('[VFD WriteL2Cells] Error:', error)
    return res.status(500).json({ error: `Failed to write L2 cells: ${error instanceof Error ? error.message : error}` })
  }
}
