import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { getPlcClient, getPlcStatus } from '@/lib/plc-client-manager'
import {
  createTag,
  plc_tag_read,
  plc_tag_write,
  plc_tag_destroy,
  plc_tag_set_int8,
  PlcTagStatus,
  getStatusMessage,
} from '@/lib/plc'

/**
 * POST /api/vfd-commissioning/clear
 *
 * Resets one VFD so it can be re-tested from scratch. This is the inverse of
 * what the wizard does. Because L2 cells are now the single source of truth,
 * "clear" means clearing those L2 cells (NULL-ing the Value) AND syncing the
 * deletion to the cloud, plus an optional set of PLC invalidate pulses so
 * STS.Valid_Map / Valid_HP / Valid_Direction drop back to false.
 *
 * Request body:
 *   { deviceName, sheetName?, clearPlc?: true }
 *
 * Response:
 *   { success, deviceName, sheetName, cellsCleared, plcAttempted, plcWrites }
 */

const COMMISSIONING_COLUMNS = [
  'Verify Identity',
  'Motor HP (Field)',
  'VFD HP (Field)',
  'Check Direction',
  'Belt Tracked',
  'Speed Set Up',
]

const stmts = {
  findDevice: db.prepare(`
    SELECT d.id as deviceId, d.SheetId, d.CloudId as deviceCloudId,
           s.Name as sheetName, s.DisplayName as sheetDisplayName
    FROM L2Devices d
    JOIN L2Sheets s ON d.SheetId = s.id
    WHERE LOWER(d.DeviceName) = LOWER(?)
  `),
  findColumn: db.prepare(`
    SELECT id, Name, CloudId as columnCloudId
    FROM L2Columns
    WHERE SheetId = ? AND LOWER(TRIM(Name)) = LOWER(TRIM(?))
  `),
  getCell: db.prepare('SELECT id, Value, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
  clearCell: db.prepare(`UPDATE L2CellValues SET Value = NULL, UpdatedBy = ?, UpdatedAt = datetime('now'), Version = ? WHERE id = ?`),
  insertPendingSync: db.prepare('INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version) VALUES (?, ?, ?, ?, ?)'),
  countCompleted: db.prepare(`SELECT COUNT(*) as cnt FROM L2CellValues cv JOIN L2Columns lc ON cv.ColumnId = lc.id WHERE cv.DeviceId = ? AND lc.IncludeInProgress = 1 AND cv.Value IS NOT NULL AND cv.Value != ''`),
  updateDeviceChecks: db.prepare('UPDATE L2Devices SET CompletedChecks = ? WHERE id = ?'),
  getCellForPush: db.prepare('SELECT Value, Version, UpdatedBy FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?'),
  deletePendingSync: db.prepare('DELETE FROM L2PendingSyncs WHERE id = ?'),
  getLatestPendingForCell: db.prepare('SELECT id FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ? ORDER BY id DESC LIMIT 1'),
  clearControlsVerified: db.prepare('DELETE FROM VfdControlsVerified WHERE deviceName = ?'),
}

async function pulseInvalidate(
  gateway: string,
  path: string,
  deviceName: string,
  field: 'Invalidate_Map' | 'Invalidate_HP' | 'Invalidate_Direction',
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const tagPath = `CBT_${deviceName}.CTRL.CMD.${field}`
  const handle = createTag({
    gateway, path, name: tagPath, elemSize: 1, elemCount: 1, timeout: timeoutMs,
  })
  if (handle < 0) return { ok: false, error: `createTag ${tagPath}: ${getStatusMessage(handle)}` }
  try {
    const r = plc_tag_read(handle, timeoutMs)
    if (r !== PlcTagStatus.PLCTAG_STATUS_OK) return { ok: false, error: `read: ${getStatusMessage(r)}` }
    const s = plc_tag_set_int8(handle, 0, 1)
    if (s !== PlcTagStatus.PLCTAG_STATUS_OK) return { ok: false, error: `set: ${getStatusMessage(s)}` }
    const w = plc_tag_write(handle, timeoutMs)
    if (w !== PlcTagStatus.PLCTAG_STATUS_OK) return { ok: false, error: `write: ${getStatusMessage(w)}` }
    return { ok: true }
  } finally {
    try { plc_tag_destroy(handle) } catch { /* ignore */ }
  }
}

export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, sheetName, clearPlc = true, updatedBy } = req.body as {
      deviceName?: string
      sheetName?: string
      clearPlc?: boolean
      updatedBy?: string
    }

    if (!deviceName) {
      return res.status(400).json({ error: 'deviceName required' })
    }

    // 1. Resolve target device + sheet
    const allMatches = stmts.findDevice.all(deviceName) as Array<{
      deviceId: number; SheetId: number; deviceCloudId: number | null
      sheetName: string; sheetDisplayName: string | null
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

    // 2. Clear (NULL out) every commissioning cell that exists, transactionally,
    //    bumping Version so the cloud sees a fresh write to apply.
    const cloudPushQueue: Array<{ deviceId: number; columnId: number; cloudDeviceId: number; cloudColumnId: number }> = []
    let cellsCleared = 0

    db.transaction(() => {
      for (const colName of COMMISSIONING_COLUMNS) {
        const col = stmts.findColumn.get(target.SheetId, colName) as
          | { id: number; Name: string; columnCloudId: number | null } | undefined
        if (!col) continue
        const existing = stmts.getCell.get(target.deviceId, col.id) as
          | { id: number; Value: string | null; Version: number } | undefined
        if (!existing) continue
        const newVersion = existing.Version + 1
        stmts.clearCell.run(updatedBy ?? null, newVersion, existing.id)
        cellsCleared++

        if (target.deviceCloudId && col.columnCloudId) {
          stmts.insertPendingSync.run(target.deviceCloudId, col.columnCloudId, null, updatedBy ?? null, newVersion - 1)
          cloudPushQueue.push({
            deviceId: target.deviceId,
            columnId: col.id,
            cloudDeviceId: target.deviceCloudId,
            cloudColumnId: col.columnCloudId,
          })
        }
      }

      // Refresh derived progress counter on the device row
      const completedCount = stmts.countCompleted.get(target.deviceId) as { cnt: number }
      stmts.updateDeviceChecks.run(completedCount?.cnt || 0, target.deviceId)

      // Also clear the local-only "Controls Verified" state
      stmts.clearControlsVerified.run(deviceName)
    })()

    // 3. Best-effort cloud push for each cleared cell
    for (const push of cloudPushQueue) {
      const key = `l2cell:${push.deviceId}-${push.columnId}`
      enqueueSyncPush(key, async () => {
        const cell = stmts.getCellForPush.get(push.deviceId, push.columnId) as
          | { Value: string | null; Version: number; UpdatedBy: string | null } | undefined
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
                value: cell.Value, // null
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
          console.warn('[VFD Clear] Cloud push failed:', err instanceof Error ? err.message : err)
        }
      })
    }

    // 4. Optional: PLC invalidate pulses
    const plcWrites: Array<{ field: string; ok: boolean; error?: string }> = []
    let plcAttempted = false
    if (clearPlc) {
      const client = getPlcClient()
      const { connectionConfig } = getPlcStatus()
      if (client.isConnected && connectionConfig) {
        plcAttempted = true
        const timeoutMs = connectionConfig.timeout || 5000
        const fields: Array<'Invalidate_Map' | 'Invalidate_HP' | 'Invalidate_Direction'> = [
          'Invalidate_Map', 'Invalidate_HP', 'Invalidate_Direction',
        ]
        for (const field of fields) {
          const r = await pulseInvalidate(connectionConfig.ip, connectionConfig.path, deviceName, field, timeoutMs)
          plcWrites.push({ field, ok: r.ok, error: r.error })
        }
      }
    }

    return res.json({
      success: true,
      deviceName,
      sheetName: target.sheetName,
      cellsCleared,
      plcAttempted,
      plcWrites,
    })
  } catch (error) {
    console.error('[VFD Clear] Error:', error)
    return res.status(500).json({ error: `Clear failed: ${error instanceof Error ? error.message : error}` })
  }
}
