export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function GET() {
  try {
    const zones = db.prepare('SELECT * FROM SafetyZones ORDER BY Name ASC').all() as any[]
    for (const zone of zones) {
      zone.drives = db.prepare('SELECT * FROM SafetyZoneDrives WHERE ZoneId = ?').all(zone.id) as any[]
    }
    return NextResponse.json({ success: true, zones })
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to fetch safety zones' }, { status: 500 })
  }
}
