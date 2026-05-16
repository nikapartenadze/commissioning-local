import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { IoSummary } from '@/lib/guided/types'

interface IoRow {
  id: number
  Name: string
  Description: string | null
  Result: string | null
  Comments: string | null
}

/**
 * GET /api/guided/devices/:name?subsystemId=...
 *
 * Returns the IOs belonging to a single device, with their current Result
 * values for display in the drawer. Read-only — no writes happen here.
 */
export async function GET(req: Request, res: Response) {
  const subsystemIdRaw = req.query.subsystemId
  const subsystemId = typeof subsystemIdRaw === 'string'
    ? parseInt(subsystemIdRaw, 10)
    : NaN
  if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ error: 'Valid subsystemId query param is required' })
  }

  const deviceName = req.params.name
  if (!deviceName) {
    return res.status(400).json({ error: 'Device name is required' })
  }

  // Primary lookup by exact NetworkDeviceName. If empty, retry with a
  // "_PD" suffix — the SVG labels laser photoeyes as e.g. "UL17_24_LPE1"
  // while the DB stores the matching photo-detector module as
  // "UL17_24_LPE1_PD". Same alias rule as /api/guided/devices.
  const stmt = db.prepare(`
    SELECT id, Name, Description, Result, Comments
      FROM Ios
     WHERE SubsystemId = ?
       AND NetworkDeviceName = ?
     ORDER BY "Order", id
  `)
  let rows = stmt.all(subsystemId, deviceName) as IoRow[]
  if (rows.length === 0 && !deviceName.endsWith('_PD')) {
    rows = stmt.all(subsystemId, deviceName + '_PD') as IoRow[]
  }

  const ios: IoSummary[] = rows.map(r => ({
    id: r.id,
    name: r.Name,
    description: r.Description,
    result: r.Result === 'Passed' || r.Result === 'Failed' ? r.Result as 'Passed' | 'Failed' : null,
    comments: r.Comments,
    ioDirection: null, // Phase 2: classify from name pattern using existing helper
  }))

  return res.json({ deviceName, ios })
}
