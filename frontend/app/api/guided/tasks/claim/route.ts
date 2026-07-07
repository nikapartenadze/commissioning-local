import type { Request, Response } from 'express'
import { claimTask, releaseClaim } from '@/lib/guided/task-pool/claims'

/**
 * POST /api/guided/tasks/claim
 *
 * Claim, heartbeat-renew or release a Guided-Mode task for a client session.
 * Claims are ephemeral in-memory coordination (TTL 45 s, heartbeat ~15 s) so
 * two testers on the same MCM are never handed the same device and don't
 * trip each other's swap detection. NOT persisted — a restart or a dead
 * tablet simply lets the claim expire.
 *
 * Body: { subsystemId, clientId, taskId?, user?, deviceName?, watchIoIds?, release? }
 *  - release:true → drop this client's claim (taskId not required)
 *  - otherwise    → claim/renew taskId for clientId
 */
export async function POST(req: Request, res: Response) {
  const body = req.body ?? {}
  const subsystemId = parseInt(String(body.subsystemId), 10)
  const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : ''
  if (!Number.isFinite(subsystemId) || subsystemId <= 0 || !clientId) {
    return res.status(400).json({ error: 'subsystemId and clientId are required' })
  }

  if (body.release === true) {
    releaseClaim(subsystemId, clientId)
    return res.json({ success: true })
  }

  const taskId = typeof body.taskId === 'string' ? body.taskId : ''
  if (!taskId) return res.status(400).json({ error: 'taskId is required to claim' })

  const result = claimTask(subsystemId, {
    taskId,
    clientId,
    user: typeof body.user === 'string' ? body.user.slice(0, 120) : null,
    deviceName: typeof body.deviceName === 'string' ? body.deviceName : null,
    watchIoIds: Array.isArray(body.watchIoIds)
      ? body.watchIoIds.filter((x: unknown) => Number.isFinite(x)).slice(0, 200)
      : [],
  })
  if (!result.ok) {
    // 409: someone else is live on this task — the runner re-fetches the pool
    // (which now carries the claim) and moves to the next unclaimed task.
    return res.status(409).json({ success: false, heldBy: result.heldBy })
  }
  return res.json({ success: true })
}
