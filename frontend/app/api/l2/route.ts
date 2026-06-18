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
}

export async function GET(req: Request, res: Response) {
  try {
    const sidRaw = req.query.subsystemId
    const sid = sidRaw != null ? parseInt(String(sidRaw), 10) : NaN
    const scoped = Number.isFinite(sid)

    const sheets = stmts.sheets.all()
    const columns = stmts.columns.all()
    const devices = scoped ? stmts.devicesScoped.all(sid) : stmts.devicesAll.all()
    const cellValues = scoped ? stmts.cellsScoped.all(sid) : stmts.cellsAll.all()

    return res.json({ sheets, columns, devices, cellValues, hasData: (sheets as any[]).length > 0 })
  } catch (error) {
    console.error('[L2 API] Error:', error)
    return res.json({ sheets: [], columns: [], devices: [], cellValues: [], hasData: false })
  }
}
