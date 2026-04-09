import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const rawZones = db.prepare('SELECT * FROM SafetyZones ORDER BY Name ASC').all() as any[]
    const zones = rawZones.map((zone: any) => {
      const rawDrives = db.prepare('SELECT * FROM SafetyZoneDrives WHERE ZoneId = ?').all(zone.id) as any[]
      return { id: zone.id, subsystemId: zone.SubsystemId, name: zone.Name, stoSignal: zone.StoSignal, bssTag: zone.BssTag, createdAt: zone.CreatedAt, drives: rawDrives.map((d: any) => ({ id: d.id, zoneId: d.ZoneId, name: d.Name })) }
    })
    return res.json({ success: true, zones })
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch safety zones' })
  }
}
