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
 *   { deviceName: "NCP1_7_VFD", completedBy: "ASH" }
 */

const stmtUpsert = db.prepare(`
  INSERT INTO VfdControlsVerified (deviceName, completedBy, completedAt)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(deviceName) DO UPDATE SET completedBy = excluded.completedBy, completedAt = excluded.completedAt
`)

export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, completedBy } = req.body
    if (!deviceName) {
      return res.status(400).json({ error: 'deviceName required' })
    }

    stmtUpsert.run(deviceName, completedBy || null)
    return res.json({ success: true })
  } catch (error) {
    console.error('[VFD ControlsVerified] Error:', error)
    return res.status(500).json({ error: `Failed to save: ${error instanceof Error ? error.message : error}` })
  }
}
