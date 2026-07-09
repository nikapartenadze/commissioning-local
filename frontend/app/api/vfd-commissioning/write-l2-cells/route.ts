import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { auditLog } from '@/lib/logging/recovery-log'
import { getBroadcastUrl } from '@/lib/broadcast-config'

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
 *       { columnName: "Check Direction", value: "ASH 9/9" }
 *     ]
 *   }
 *
 * Response:
 *   { success: true, written: [{ columnName, ok, error? }] }
 */

const stmts = {
  findDevice: db.prepare(`
    SELECT d.id as deviceId, d.SheetId, d.SubsystemId as subsystemId, s.Name as sheetName, s.DisplayName as sheetDisplayName
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
      deviceId: number; SheetId: number; subsystemId: number | null; sheetName: string; sheetDisplayName: string
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
    // Collected during the transaction; emitted after commit so the open
    // L2/FV grid in the same browser tab refreshes immediately. Without
    // this the local UI only updates after the cell round-trips through
    // cloud SSE (~30 s minimum), which made the wizard's auto-backfill
    // and Confirm clicks look like no-ops.
    const localBroadcasts: Array<{
      cloudDeviceId: number | null; cloudColumnId: number | null
      localDeviceId: number; localColumnId: number
      value: string | null; version: number
    }> = []
    // Per-cell recovery-journal entries, collected inside the transaction and
    // emitted only after a successful commit (auditLog never throws). This is
    // the CDW5-polarity incident class: wizard L2 writes previously left NO
    // durable local record. Shape mirrors app/api/l2/cell/route.ts ('l2.cell')
    // so forensics tooling can parse both paths.
    const auditEntries: Array<{
      columnId: number; column: string; oldValue: string | null
      value: string | null; version: number
      cloudDeviceId: number | null; cloudColumnId: number | null
    }> = []

    db.transaction(() => {
      for (const cell of cells) {
        const col = stmts.findColumn.get(target.SheetId, cell.columnName) as {
          id: number; Name: string; IsEditable: number
        } | undefined

        if (!col) {
          // Loud server-side trace: a dropped commissioning cell (esp. "Polarity")
          // means the durable record of an operator action is being discarded —
          // exactly what silently lost three weeks of CDW5 polarity work when the
          // column hadn't been deployed yet (May 2026).
          console.warn(
            `[VFD WriteL2Cells] DROPPED cell write — column "${cell.columnName}" does not exist ` +
            `in sheet "${target.sheetName}" (device ${deviceName}, value ${JSON.stringify(cell.value)}). ` +
            `Pull the latest L2 data from cloud to receive missing columns.`,
          )
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

        localBroadcasts.push({
          cloudDeviceId: device?.CloudId ?? null,
          cloudColumnId: column?.CloudId ?? null,
          localDeviceId: target.deviceId,
          localColumnId: col.id,
          value: cell.value ?? null,
          version: newVersion,
        })

        const completedCount = stmts.countCompleted.get(target.deviceId) as { cnt: number }
        stmts.updateDeviceChecks.run(completedCount?.cnt || 0, target.deviceId)

        auditEntries.push({
          columnId: col.id,
          column: col.Name,
          oldValue: existing?.Value ?? null,
          value: cell.value ?? null,
          version: newVersion,
          cloudDeviceId: device?.CloudId ?? null,
          cloudColumnId: column?.CloudId ?? null,
        })

        written.push({ columnName: cell.columnName, ok: true })
      }
    })()

    // Durable recovery trail for every committed wizard cell write — parity
    // with app/api/l2/cell/route.ts. An unmapped cell can NEVER sync, so it is
    // additionally recorded as an l2.push.drop (the F4 gap).
    for (const entry of auditEntries) {
      auditLog({
        type: 'l2.cell',
        subsystemId: target.subsystemId ?? null,
        user: updatedBy ?? null,
        version: entry.version,
        detail: {
          deviceId: target.deviceId,
          columnId: entry.columnId,
          cloudDeviceId: entry.cloudDeviceId,
          cloudColumnId: entry.cloudColumnId,
          deviceName,
          column: entry.column,
          oldValue: entry.oldValue,
          value: entry.value,
          via: 'vfd-wizard',
        },
      })
      if (!entry.cloudDeviceId || !entry.cloudColumnId) {
        auditLog({
          type: 'l2.push.drop',
          subsystemId: target.subsystemId ?? null,
          user: updatedBy ?? null,
          version: entry.version,
          reason: 'unmapped: L2 device/column has no CloudId — cannot sync to cloud',
          detail: { deviceId: target.deviceId, columnId: entry.columnId, deviceName, column: entry.column, value: entry.value, via: 'vfd-wizard' },
        })
      }
    }

    // Broadcast each successfully-written cell to the local WS so the open
    // L2/FV grid refreshes in real time. Same envelope shape the cloud SSE
    // path uses, so the existing `L2CellUpdated` handler in the React side
    // picks it up without any client-side changes.
    const updatedAt = new Date().toISOString()
    // Honour WS_BROADCAST_URL (dev runs the bridge on :3112) — a hardcoded
    // port broadcasts into the void and the open grid never live-refreshes.
    // Single-sourced via lib/broadcast-config so the port can't drift (D8).
    const broadcastUrl = getBroadcastUrl()
    for (const b of localBroadcasts) {
      fetch(broadcastUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'L2CellUpdated',
          cloudDeviceId: b.cloudDeviceId,
          cloudColumnId: b.cloudColumnId,
          localDeviceId: b.localDeviceId,
          localColumnId: b.localColumnId,
          value: b.value,
          version: b.version,
          updatedBy: updatedBy ?? null,
          updatedAt,
        }),
      }).catch(() => { /* best-effort — broadcast bridge may be momentarily down */ })
    }

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

    // If any commissioning check cell was written, trigger background sync of
    // VFD validation flags to the PLC (Valid_Map, Valid_HP, Valid_Direction,
    // and the Normal/Reverse_Polarity pair derived from "Polarity").
    const checkCellWritten = written.some(w => w.ok && [
      'Verify Identity', 'Check Direction', 'Motor HP (Field)', 'VFD HP (Field)', 'Polarity',
    ].includes(w.columnName))
    if (checkCellWritten) {
      import('@/lib/vfd-validation-writer')
        .then(m => m.triggerValidationSync())
        .catch(() => { /* best-effort */ })
    }

    // A dropped cell (column not found in the sheet) means the durable record of
    // an operator action — e.g. "Polarity" — was discarded. Returning HTTP 200
    // let a caller that only checks the status code (not the `written` array)
    // believe the value was stored: this is the CDW5-polarity data-loss class.
    // Signal it with HTTP 422 and enumerate the dropped cells so the failure is
    // impossible to miss, while still persisting the cells that DID match.
    const dropped = written.filter(w => !w.ok)
    return res.status(dropped.length > 0 ? 422 : 200).json({
      success: dropped.length === 0,
      written,
      dropped,
      sheet: target.sheetName,
      deviceId: target.deviceId,
    })
  } catch (error) {
    console.error('[VFD WriteL2Cells] Error:', error)
    return res.status(500).json({ error: `Failed to write L2 cells: ${error instanceof Error ? error.message : error}` })
  }
}
