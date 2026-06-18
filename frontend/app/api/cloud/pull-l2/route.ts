/**
 * POST /api/cloud/pull-l2 — Pull only L2/FV data from cloud
 *
 * Body: { remoteUrl: string, apiPassword?: string, subsystemId: number }
 *
 * Standalone FV pull — does NOT touch IOs, network, estop etc.
 * Used by the FV page retry button when the initial full pull missed FV data.
 */

import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function POST(req: Request, res: Response) {
  try {
    const { remoteUrl, apiPassword, subsystemId } = req.body || {}

    if (!remoteUrl || !subsystemId) {
      return res.status(400).json({ success: false, error: 'remoteUrl and subsystemId are required' })
    }

    const l2Url = `${remoteUrl}/api/sync/l2/${subsystemId}`
    console.log(`[L2Pull] Fetching FV data from: ${l2Url}`)
    console.log(`[L2Pull] API key: ${apiPassword ? `set (${apiPassword.length} chars)` : 'NOT SET'}`)

    const l2Res = await fetch(l2Url, {
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
      signal: AbortSignal.timeout(30000),
    })

    console.log(`[L2Pull] Cloud response: ${l2Res.status} ${l2Res.statusText}`)

    if (!l2Res.ok) {
      const errorText = await l2Res.text().catch(() => '(could not read response body)')
      const msg = `Cloud returned HTTP ${l2Res.status}: ${errorText.slice(0, 300)}`
      console.error(`[L2Pull] FAILED: ${msg}`)

      if (l2Res.status === 404) {
        return res.json({ success: true, l2Pulled: 0, l2CellsPulled: 0, error: 'L2 endpoint not found on cloud (404)' })
      }
      if (l2Res.status === 401) {
        return res.status(401).json({ success: false, error: 'API key rejected by cloud (401 Unauthorized)' })
      }
      if (l2Res.status === 403) {
        return res.status(403).json({ success: false, error: 'API key not authorized for this subsystem (403 Forbidden)' })
      }
      return res.status(502).json({ success: false, error: msg })
    }

    const data = await l2Res.json()
    console.log(`[L2Pull] Parsed: success=${data.success}, sheets=${data.sheets?.length || 0}, devices=${data.devices?.length || 0}, cellValues=${data.cellValues?.length || 0}`)

    if (!data.success) {
      const msg = data.error || 'Cloud returned success=false (unknown reason)'
      console.error(`[L2Pull] Cloud error: ${msg}`)
      return res.status(502).json({ success: false, error: msg })
    }

    if (!data.sheets || data.sheets.length === 0) {
      console.warn('[L2Pull] No sheets — no L2 template configured on cloud for this project')
      return res.json({ success: true, l2Pulled: 0, l2CellsPulled: 0, message: 'No FV template configured on cloud' })
    }

    // Pre-pull safety backup. FV/L2 cell values are real commissioning work and
    // the rewrite below is DESTRUCTIVE for this subsystem's devices/cells — if
    // the backup fails, ABORT rather than wipe with no safety net (mirrors the
    // IO pull's B6). Closes the pre-existing L2 data-loss hole (pull-l2 used to
    // DELETE every L2 cell value with no backup at all).
    try {
      const { createBackup } = await import('@/lib/db/backup')
      const backup = await createBackup(`pre-pull-l2-mcm${subsystemId}`)
      console.log(`[L2Pull] Auto-backup created: ${backup.filename}`)
    } catch (backupErr) {
      console.error('[L2Pull] Pre-pull backup FAILED — aborting to protect local FV data:', backupErr)
      return res.status(500).json({ success: false, error: 'Pre-pull safety backup failed; L2 pull aborted to protect local data.' })
    }

    const sid = Number(subsystemId)
    let l2Pulled = 0
    let l2CellsPulled = 0

    const result = db.transaction(() => {
      // Sheets + columns are PROJECT-GLOBAL templates shared by every MCM —
      // UPSERT them by CloudId so repeated per-MCM pulls neither duplicate nor
      // clobber them (and don't churn local ids).
      const findSheet = db.prepare('SELECT id FROM L2Sheets WHERE CloudId = ?')
      const insertSheet = db.prepare('INSERT INTO L2Sheets (CloudId, Name, DisplayName, DisplayOrder, Discipline, DeviceCount) VALUES (?, ?, ?, ?, ?, ?)')
      const updateSheet = db.prepare('UPDATE L2Sheets SET Name=?, DisplayName=?, DisplayOrder=?, Discipline=?, DeviceCount=? WHERE id=?')
      const findCol = db.prepare('SELECT id FROM L2Columns WHERE CloudId = ?')
      const insertCol = db.prepare('INSERT INTO L2Columns (CloudId, SheetId, Name, ColumnType, InputType, DisplayOrder, IsSystem, IsEditable, IncludeInProgress, IsRequired, Description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const updateCol = db.prepare('UPDATE L2Columns SET SheetId=?, Name=?, ColumnType=?, InputType=?, DisplayOrder=?, IsSystem=?, IsEditable=?, IncludeInProgress=?, IsRequired=?, Description=? WHERE id=?')
      const insertDev = db.prepare('INSERT INTO L2Devices (CloudId, SubsystemId, SheetId, DeviceName, Mcm, Subsystem, DisplayOrder, CompletedChecks, TotalChecks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const insertCell = db.prepare('INSERT OR REPLACE INTO L2CellValues (CloudCellId, DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, ?, ?, ?)')

      const sheetIdMap = new Map<number, number>()
      const columnIdMap = new Map<number, number>()
      const deviceIdMap = new Map<number, number>()

      for (const sheet of data.sheets) {
        const existing = findSheet.get(sheet.id) as { id: number } | undefined
        let localSheetId: number
        if (existing) {
          localSheetId = existing.id
          updateSheet.run(sheet.name, sheet.displayName, sheet.displayOrder, sheet.discipline, sheet.deviceCount || 0, localSheetId)
        } else {
          localSheetId = insertSheet.run(sheet.id, sheet.name, sheet.displayName, sheet.displayOrder, sheet.discipline, sheet.deviceCount || 0).lastInsertRowid as number
        }
        sheetIdMap.set(sheet.id, localSheetId)
        for (const col of (sheet.columns || [])) {
          const colArgs = [
            localSheetId, col.name, col.columnType, col.inputType || col.columnType, col.displayOrder,
            col.isSystem ? 1 : 0, col.isEditable === false ? 0 : 1, col.includeInProgress ? 1 : 0,
            col.isRequired ? 1 : 0, col.description || null,
          ]
          const ec = findCol.get(col.id) as { id: number } | undefined
          let localColId: number
          if (ec) {
            localColId = ec.id
            updateCol.run(...colArgs, localColId)
          } else {
            localColId = insertCol.run(col.id, ...colArgs).lastInsertRowid as number
          }
          columnIdMap.set(col.id, localColId)
        }
      }

      // Scope: replace ONLY this subsystem's devices/cells (plus any legacy
      // unscoped rows from before SubsystemId existed). Every OTHER MCM's L2
      // data is preserved — this is what lets the central server hold all MCMs.
      // FK cascade isn't guaranteed (foreign_keys pragma may be off), so delete
      // the dependent cells explicitly first.
      db.prepare('DELETE FROM L2CellValues WHERE DeviceId IN (SELECT id FROM L2Devices WHERE SubsystemId = ? OR SubsystemId IS NULL)').run(sid)
      db.prepare('DELETE FROM L2Devices WHERE SubsystemId = ? OR SubsystemId IS NULL').run(sid)

      for (const dev of (data.devices || [])) {
        const localSheetId = sheetIdMap.get(dev.sheetId)
        if (!localSheetId) continue
        const dr = insertDev.run(dev.id, sid, localSheetId, dev.deviceName, dev.mcm, dev.subsystem, dev.displayOrder, dev.completedChecks || 0, dev.totalChecks || 0)
        deviceIdMap.set(dev.id, dr.lastInsertRowid as number)
        l2Pulled++
      }

      for (const cell of (data.cellValues || [])) {
        const ld = deviceIdMap.get(cell.deviceId)
        const lc = columnIdMap.get(cell.columnId)
        if (ld && lc) {
          insertCell.run(cell.id, ld, lc, cell.value, cell.updatedBy, cell.updatedAt, Number(cell.version) || 0)
          l2CellsPulled++
        }
      }

      return { sheetsCount: data.sheets.length, l2Pulled, l2CellsPulled }
    })()

    console.log(`[L2Pull] SUCCESS: ${result.sheetsCount} sheets, ${result.l2Pulled} devices, ${result.l2CellsPulled} cells`)

    // Sync VFD validation flags to PLC for pulled L2 data
    if (result.l2CellsPulled > 0) {
      import('@/lib/vfd-validation-writer')
        .then(m => m.triggerValidationSync())
        .catch(() => { /* best-effort */ })
    }

    return res.json({
      success: true,
      l2Pulled: result.l2Pulled,
      l2CellsPulled: result.l2CellsPulled,
      sheetsCount: result.sheetsCount,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[L2Pull] EXCEPTION:', msg)
    return res.status(500).json({ success: false, error: msg })
  }
}
