import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

// Sheets + columns are project-global templates (shared by every MCM). Devices
// and their cell values belong to a specific MCM (L2Devices.SubsystemId). When
// a subsystemId is supplied (central server: one FV page per MCM) we scope
// devices/cells to it; legacy rows with NULL SubsystemId (single-MCM tablets,
// pre-migration) match any subsystem so nothing disappears before the next
// scoped pull re-stamps them. No subsystemId → return everything (unchanged
// standalone behavior).
const stmts = {
  sheets: db.prepare('SELECT * FROM L2Sheets ORDER BY DisplayOrder'),
  columns: db.prepare('SELECT * FROM L2Columns ORDER BY DisplayOrder'),
  devicesAll: db.prepare('SELECT * FROM L2Devices ORDER BY DisplayOrder'),
  devicesScoped: db.prepare(
    'SELECT * FROM L2Devices WHERE SubsystemId = ? OR SubsystemId IS NULL ORDER BY DisplayOrder',
  ),
  cellsAll: db.prepare('SELECT DeviceId, ColumnId, Value, Version FROM L2CellValues'),
  cellsScoped: db.prepare(
    `SELECT cv.DeviceId, cv.ColumnId, cv.Value, cv.Version
       FROM L2CellValues cv
       JOIN L2Devices d ON d.id = cv.DeviceId
      WHERE d.SubsystemId = ? OR d.SubsystemId IS NULL`,
  ),
  // VFD-only scope (?vfd=1) — the VFD Commissioning tab. It deliberately does
  // NOT scope by subsystem (VFD/APF devices may be keyed to a different
  // subsystem than the route), but it only needs the VFD/APF sheet — so scope
  // by SHEET here instead of returning every sheet's devices + the whole
  // L2CellValues table. Matches the client's filter exactly (sheet name VFD/APF
  // OR device name contains VFD), so the visible set is identical but the
  // payload is a fraction (one sheet vs all sheets across all MCMs).
  devicesVfd: db.prepare(
    `SELECT d.* FROM L2Devices d
      WHERE (d.SheetId IN (SELECT id FROM L2Sheets WHERE UPPER(Name) LIKE '%VFD%' OR UPPER(Name) LIKE '%APF%') OR UPPER(d.DeviceName) LIKE '%VFD%')
      ORDER BY d.DisplayOrder`,
  ),
  cellsVfd: db.prepare(
    `SELECT cv.DeviceId, cv.ColumnId, cv.Value, cv.Version
       FROM L2CellValues cv
       JOIN L2Devices d ON d.id = cv.DeviceId
      WHERE (d.SheetId IN (SELECT id FROM L2Sheets WHERE UPPER(Name) LIKE '%VFD%' OR UPPER(Name) LIKE '%APF%') OR UPPER(d.DeviceName) LIKE '%VFD%')`,
  ),
}

export async function GET(req: Request, res: Response) {
  try {
    const sidRaw = req.query.subsystemId
    const sid = sidRaw != null ? parseInt(String(sidRaw), 10) : NaN
    const scoped = Number.isFinite(sid)
    const vfdOnly = req.query.vfd === '1' || req.query.vfd === 'true'

    const sheets = stmts.sheets.all()
    const columns = stmts.columns.all()
    const devices = vfdOnly
      ? stmts.devicesVfd.all()
      : scoped ? stmts.devicesScoped.all(sid) : stmts.devicesAll.all()
    const cellValues = vfdOnly
      ? stmts.cellsVfd.all()
      : scoped ? stmts.cellsScoped.all(sid) : stmts.cellsAll.all()

    return res.json({ sheets, columns, devices, cellValues, hasData: (sheets as any[]).length > 0 })
  } catch (error) {
    console.error('[L2 API] Error:', error)
    return res.json({ sheets: [], columns: [], devices: [], cellValues: [], hasData: false })
  }
}
