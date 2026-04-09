export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

// Prepared statements — created once, reused per request
const stmts = {
  sheets: db.prepare('SELECT * FROM L2Sheets ORDER BY DisplayOrder'),
  columns: db.prepare('SELECT * FROM L2Columns ORDER BY DisplayOrder'),
  devices: db.prepare('SELECT * FROM L2Devices ORDER BY DisplayOrder'),
  cellValues: db.prepare('SELECT DeviceId, ColumnId, Value, Version FROM L2CellValues'),
}

export async function GET() {
  try {
    const sheets = stmts.sheets.all()
    const columns = stmts.columns.all()
    const devices = stmts.devices.all()
    const cellValues = stmts.cellValues.all()

    return NextResponse.json({
      sheets,
      columns,
      devices,
      cellValues,
      hasData: (sheets as any[]).length > 0
    })
  } catch (error) {
    console.error('[L2 API] Error:', error)
    return NextResponse.json({ sheets: [], columns: [], devices: [], cellValues: [], hasData: false })
  }
}
