import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { enqueueGuidedTaskStateSync } from '@/lib/cloud/guided-task-state-sync'

/**
 * POST /api/guided/tasks/complete
 *
 * Records a manual "mark done" for a Guided-Mode task whose detailed entry
 * lives in an existing specialized view (network loop, VFD setup, functional
 * check). Data-backed tasks (IO checks, e-stop) derive completion from their
 * own rows and should NOT use this — they complete by recording results.
 *
 * Stored in GuidedTaskState so the pool rebuild sees the task as completed.
 *
 * Body: { subsystemId, taskId, currentUser?, undo? }
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

    if (body.undo === true) {
      db.prepare(
        'DELETE FROM GuidedTaskState WHERE SubsystemId = ? AND TaskId = ? AND Status = ?',
      ).run(subsystemId, taskId, 'completed')
      enqueueGuidedTaskStateSync(subsystemId, taskId, 'cleared', null, null)
      return res.json({ success: true, taskId, status: 'cleared' })
    }

    const actor = typeof body.currentUser === 'string' ? body.currentUser : null
    db.prepare(
      `INSERT INTO GuidedTaskState (SubsystemId, TaskId, Status, Reason, ActorName, UpdatedAt)
       VALUES (?, ?, 'completed', NULL, ?, datetime('now'))
       ON CONFLICT(SubsystemId, TaskId)
       DO UPDATE SET Status='completed', Reason=NULL, ActorName=excluded.ActorName, UpdatedAt=datetime('now')`,
    ).run(subsystemId, taskId, actor)
    enqueueGuidedTaskStateSync(subsystemId, taskId, 'completed', null, actor)

    return res.json({ success: true, taskId, status: 'completed' })
  } catch (error) {
    console.error('[Guided tasks/complete] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
  }
}
