export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function GET() {
  try {
    const rawZones = db.prepare('SELECT * FROM SafetyZones ORDER BY Name ASC').all() as any[]
    const zones = rawZones.map((zone: any) => {
      const rawDrives = db.prepare('SELECT * FROM SafetyZoneDrives WHERE ZoneId = ?').all(zone.id) as any[]
      return {
        id: zone.id,
        subsystemId: zone.SubsystemId,
        name: zone.Name,
        stoSignal: zone.StoSignal,
        bssTag: zone.BssTag,
        createdAt: zone.CreatedAt,
        drives: rawDrives.map((d: any) => ({
          id: d.id,
          zoneId: d.ZoneId,
          name: d.Name,
        })),
      }
    })
    return NextResponse.json({ success: true, zones })
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to fetch safety zones' }, { status: 500 })
  }
}
