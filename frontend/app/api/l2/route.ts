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
  // VFD-only scope (?vfd=1) — the VFD Commissioning tab. Narrows to the VFD/APF
  // sheet so the payload is one sheet rather than every sheet's devices plus the
  // whole L2CellValues table (the multi-second empty-grid delay on CDW5).
  //
  // These are combined with the subsystem predicate when a subsystemId is
  // supplied. An earlier version deliberately skipped the subsystem filter,
  // on the rationale that VFD/APF belts were cloud-keyed to a different
  // subsystem than the route (":id is 16 but the cloud stamped 38"), so
  // scoping would show an empty sheet. That was true only while the
  // project-15/18 key mismatch was live; it has since been fixed and every
  // VFD/APF device now carries the SubsystemId matching its own MCM. The
  // bypass outlived its cause and made every MCM's belts render on every
  // MCM's page — including the wizard, which then wrote to the wrong PLC.
  vfdWhere: `(d.SheetId IN (SELECT id FROM L2Sheets WHERE UPPER(Name) LIKE '%VFD%' OR UPPER(Name) LIKE '%APF%') OR UPPER(d.DeviceName) LIKE '%VFD%')`,
}

const vfdStmts = {
  devicesAll: db.prepare(
    `SELECT d.* FROM L2Devices d WHERE ${stmts.vfdWhere} ORDER BY d.DisplayOrder`,
  ),
  devicesScoped: db.prepare(
    `SELECT d.* FROM L2Devices d
      WHERE ${stmts.vfdWhere} AND (d.SubsystemId = ? OR d.SubsystemId IS NULL)
      ORDER BY d.DisplayOrder`,
  ),
  cellsAll: db.prepare(
    `SELECT cv.DeviceId, cv.ColumnId, cv.Value, cv.Version
       FROM L2CellValues cv JOIN L2Devices d ON d.id = cv.DeviceId
      WHERE ${stmts.vfdWhere}`,
  ),
  cellsScoped: db.prepare(
    `SELECT cv.DeviceId, cv.ColumnId, cv.Value, cv.Version
       FROM L2CellValues cv JOIN L2Devices d ON d.id = cv.DeviceId
      WHERE ${stmts.vfdWhere} AND (d.SubsystemId = ? OR d.SubsystemId IS NULL)`,
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
      ? (scoped ? vfdStmts.devicesScoped.all(sid) : vfdStmts.devicesAll.all())
      : scoped ? stmts.devicesScoped.all(sid) : stmts.devicesAll.all()
    const cellValues = vfdOnly
      ? (scoped ? vfdStmts.cellsScoped.all(sid) : vfdStmts.cellsAll.all())
      : scoped ? stmts.cellsScoped.all(sid) : stmts.cellsAll.all()

    return res.json({ sheets, columns, devices, cellValues, hasData: (sheets as any[]).length > 0 })
  } catch (error) {
    console.error('[L2 API] Error:', error)
    return res.json({ sheets: [], columns: [], devices: [], cellValues: [], hasData: false })
  }
}
