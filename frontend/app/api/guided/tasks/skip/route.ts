import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * POST /api/guided/tasks/skip
 *
 * Records a tester's decision to skip a Guided-Mode task. A reason is required
 * (the spec: "the user must enter a reason why they are skipping"). Stored in
 * GuidedTaskState keyed by (SubsystemId, TaskId) so the skip survives a pool
 * rebuild and shows in the Task Viewer.
 *
 * Body: { subsystemId, taskId, reason, currentUser? }
 * Pass reason === '' / status 'unskip' to clear a previous skip.
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = req.body ?? {}
    const subsystemId = parseInt(String(body.subsystemId), 10)
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
    if (!Number.isFinite(subsystemId) || subsystemId <= 0) {
      return res.status(400).json({ error: 'Valid subsystemId is required' })
    }
    if (!taskId) {
      return res.status(400).json({ error: 'taskId is required' })
    }

    // Unskip path
    if (body.unskip === true) {
      db.prepare('DELETE FROM GuidedTaskState WHERE SubsystemId = ? AND TaskId = ? AND Status = ?').run(
        subsystemId,
        taskId,
        'skipped',
      )
      return res.json({ success: true, taskId, status: 'cleared' })
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) {
      return res.status(400).json({ error: 'A skip reason is required' })
    }
    if (reason.length > 500) {
      return res.status(400).json({ error: 'Reason must be 500 characters or fewer' })
    }
    const actor = typeof body.currentUser === 'string' ? body.currentUser : null

    db.prepare(
      `INSERT INTO GuidedTaskState (SubsystemId, TaskId, Status, Reason, ActorName, UpdatedAt)
       VALUES (?, ?, 'skipped', ?, ?, datetime('now'))
       ON CONFLICT(SubsystemId, TaskId)
       DO UPDATE SET Status='skipped', Reason=excluded.Reason, ActorName=excluded.ActorName, UpdatedAt=datetime('now')`,
    ).run(subsystemId, taskId, reason, actor)

    return res.json({ success: true, taskId, status: 'skipped', reason })
  } catch (error) {
    console.error('[Guided tasks/skip] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
  }
}
