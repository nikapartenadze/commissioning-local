import type { Request, Response } from 'express'
import { loadSnapshot } from '@/lib/guided/task-pool/snapshot'
import { buildTaskPool } from '@/lib/guided/task-pool/task-builder'
import { applyClaims, getActiveClaims } from '@/lib/guided/task-pool/claims'

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
  // Multi-user: overlay other testers' live claims (claimedBy labels + a
  // nextTaskId that skips their tasks). clientId identifies the caller so
  // their OWN claim stays invisible to them.
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : null
  return res.json(applyClaims(pool, getActiveClaims(subsystemId), clientId))
}
