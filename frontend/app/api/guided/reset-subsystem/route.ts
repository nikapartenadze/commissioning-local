import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

/**
 * POST /api/guided/reset-subsystem
 *
 * Demo helper: wipes Ios.Result / TestedBy / Timestamp / Comments for the
 * currently-configured subsystem so the operator can re-walk the same set
 * of devices without manually clearing each row. The local SQLite is the
 * authority for test results, so this is sufficient — cloud will pick up
 * the cleared state on next push.
 *
 * Gated to non-production environments by default (NODE_ENV !== 'production').
 * Lift the gate intentionally if you ever want to expose this on a tablet.
 */
const clearStmt = db.prepare(`
  UPDATE Ios
     SET Result = NULL,
         TestedBy = NULL,
         Timestamp = NULL,
         Comments = NULL
   WHERE SubsystemId = ?
`)

export async function POST(_req: Request, res: Response) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Reset is disabled in production' })
  }

  try {
    const config = await configService.getConfig()
    const subsystemId = typeof config.subsystemId === 'string'
      ? parseInt(config.subsystemId, 10)
      : config.subsystemId

    if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
      return res.status(400).json({ success: false, error: 'No subsystem configured' })
    }

    const info = clearStmt.run(subsystemId)
    return res.json({ success: true, subsystemId, cleared: info.changes })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[ResetSubsystem] Error:', message)
    return res.status(500).json({ success: false, error: message })
  }
}
