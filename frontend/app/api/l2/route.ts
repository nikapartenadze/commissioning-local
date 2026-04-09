import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

const stmts = {
  sheets: db.prepare('SELECT * FROM L2Sheets ORDER BY DisplayOrder'),
  columns: db.prepare('SELECT * FROM L2Columns ORDER BY DisplayOrder'),
  devices: db.prepare('SELECT * FROM L2Devices ORDER BY DisplayOrder'),
  cellValues: db.prepare('SELECT DeviceId, ColumnId, Value, Version FROM L2CellValues'),
}

export async function GET(req: Request, res: Response) {
  try {
    const sheets = stmts.sheets.all()
    const columns = stmts.columns.all()
    const devices = stmts.devices.all()
    const cellValues = stmts.cellValues.all()

    return res.json({ sheets, columns, devices, cellValues, hasData: (sheets as any[]).length > 0 })
  } catch (error) {
    console.error('[L2 API] Error:', error)
    return res.json({ sheets: [], columns: [], devices: [], cellValues: [], hasData: false })
  }
}
