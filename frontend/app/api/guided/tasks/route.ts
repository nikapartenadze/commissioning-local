import type { Request, Response } from 'express'
import { loadSnapshot } from '@/lib/guided/task-pool/snapshot'
import { buildTaskPool } from '@/lib/guided/task-pool/task-builder'

/**
 * GET /api/guided/tasks?subsystemId=...
 *
 * Returns the full prioritised Guided-Mode task pool for a subsystem: every
 * candidate Task with its computed lifecycle state, unmet dependencies and
 * progress, plus the id of the highest-priority task the tester should do next.
 *
 * The pool is recomputed from live data on every call (cheap — a handful of
 * indexed queries), so it always reflects the latest IO/L2/e-stop results.
 */
export async function GET(req: Request, res: Response) {
  const raw = req.query.subsystemId
  const subsystemId = typeof raw === 'string' ? parseInt(raw, 10) : NaN
  if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ error: 'Valid subsystemId query param is required' })
  }
  const snapshot = await loadSnapshot(subsystemId)
  const pool = buildTaskPool(snapshot)
  return res.json(pool)
}
