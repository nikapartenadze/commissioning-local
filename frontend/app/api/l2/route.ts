export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function GET() {
  try {
    const sheets = db.prepare('SELECT * FROM L2Sheets ORDER BY DisplayOrder').all()
    const columns = db.prepare('SELECT * FROM L2Columns ORDER BY DisplayOrder').all()
    const devices = db.prepare('SELECT * FROM L2Devices ORDER BY DisplayOrder').all()
    const cellValues = db.prepare('SELECT * FROM L2CellValues').all()

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
