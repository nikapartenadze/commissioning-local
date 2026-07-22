import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * POST /api/vfd-commissioning/controls-verified
 *
 * Persists the Step 4 "Controls Verified" state for a VFD device.
 * This has no L2 column — it's stored locally so reopening the wizard
 * remembers the tech already verified keypad controls (F0/F1/F2).
 *
 * Request body:
 *   { subsystemId: 40, deviceName: "NCP1_7_VFD", completedBy: "ASH" }
 *
 * subsystemId is REQUIRED. VFD device names repeat across MCMs (MCM02 and
 * MCM04 both have an NCP1_7_VFD), so a name-only stamp marked every MCM's
 * identically-named VFD verified — a false pass on untested hardware.
 */

const stmtUpsert = db.prepare(`
  INSERT INTO VfdControlsVerified (SubsystemId, deviceName, completedBy, completedAt)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(SubsystemId, deviceName) DO UPDATE SET completedBy = excluded.completedBy, completedAt = excluded.completedAt
`)

export async function POST(req: Request, res: Response) {
  try {
    const { subsystemId, deviceName, completedBy } = req.body
    if (!deviceName) {
      return res.status(400).json({ error: 'deviceName required' })
    }
    const sid = parseInt(String(subsystemId), 10)
    if (!Number.isFinite(sid) || sid <= 0) {
      return res.status(400).json({ error: 'subsystemId required (positive integer)' })
    }

    stmtUpsert.run(sid, deviceName, completedBy || null)
    return res.json({ success: true })
  } catch (error) {
    console.error('[VFD ControlsVerified] Error:', error)
    return res.status(500).json({ error: `Failed to save: ${error instanceof Error ? error.message : error}` })
  }
}
