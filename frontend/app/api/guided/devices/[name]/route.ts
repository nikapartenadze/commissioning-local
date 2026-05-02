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

  const rows = db.prepare(`
    SELECT id, Name, Description, Result, Comments
      FROM Ios
     WHERE SubsystemId = ?
       AND NetworkDeviceName = ?
     ORDER BY "Order", id
  `).all(subsystemId, deviceName) as IoRow[]

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
