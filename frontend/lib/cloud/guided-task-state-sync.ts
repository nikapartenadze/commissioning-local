/**
 * Guided-Mode task-state cloud sync (skip / mark-done overrides).
 *
 * GuidedTaskState rows were previously LOCAL-ONLY — a tester's skip-with-reason
 * or manual "mark done" never reached the cloud, so the central dashboard and a
 * second laptop on the same subsystem never saw it. This mirrors the L2 cell
 * sync pattern:
 *   - the route writes GuidedTaskState locally as today,
 *   - then calls enqueueGuidedTaskStateSync() which inserts a
 *     GuidedTaskStatePendingSyncs row and fires an immediate, subsystem-scoped
 *     push to POST {remoteUrl}/api/sync/guided-task-state.
 *
 * Non-OK / offline pushes leave the pending row in place for the periodic
 * background drain (lib/cloud/auto-sync.ts) — the local write is never blocked.
 *
 * GuidedTaskState has no Version column; identity is (SubsystemId, TaskId) and
 * the newest queued state for a task wins (the cloud receiver applies
 * last-write-wins on UpdatedAt).
 */
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'

const insertPendingSync = db.prepare(
  `INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status, Reason, ActorName, UpdatedAt)
   VALUES (?, ?, ?, ?, ?, ?)`,
)
const getLatestPending = db.prepare(
  `SELECT id, Status, Reason, ActorName, UpdatedAt
     FROM GuidedTaskStatePendingSyncs
    WHERE SubsystemId = ? AND TaskId = ?
    ORDER BY id DESC LIMIT 1`,
)
const deleteAllPendingForTask = db.prepare(
  'DELETE FROM GuidedTaskStatePendingSyncs WHERE SubsystemId = ? AND TaskId = ?',
)
const incrementPendingRetry = db.prepare(
  'UPDATE GuidedTaskStatePendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE SubsystemId = ? AND TaskId = ?',
)

interface PendingRow {
  id: number
  Status: string
  Reason: string | null
  ActorName: string | null
  UpdatedAt: string | null
}

/**
 * Enqueue a pending-sync row for a guided task-state change and fire an
 * immediate, subsystem-scoped push to the cloud. Retry-safe.
 *
 * @param status 'completed' | 'skipped' | 'cleared' — 'cleared' is an undo
 *               (the local GuidedTaskState row was deleted).
 */
export function enqueueGuidedTaskStateSync(
  subsystemId: number,
  taskId: string,
  status: string,
  reason: string | null,
  actorName: string | null,
): void {
  const updatedAt = new Date().toISOString()
  insertPendingSync.run(subsystemId, taskId, status, reason, actorName, updatedAt)

  const key = `guidedtaskstate:${subsystemId}-${taskId}`
  enqueueSyncPush(key, async () => {
    // Push the LATEST queued state for this task (handles rapid edits).
    const latest = getLatestPending.get(subsystemId, taskId) as PendingRow | undefined
    if (!latest) return

    const config = await configService.getConfig()
    if (!config.remoteUrl) return

    let resp: globalThis.Response
    try {
      resp = await fetch(`${config.remoteUrl}/api/sync/guided-task-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiPassword || '' },
        body: JSON.stringify({
          subsystemId,
          states: [{
            taskId,
            status: latest.Status,
            reason: latest.Reason,
            actorName: latest.ActorName,
            updatedAt: latest.UpdatedAt,
          }],
        }),
        signal: AbortSignal.timeout(10000),
      })
    } catch (err) {
      console.warn(`[GuidedTaskState Sync] Network error pushing task ${taskId}:`, err instanceof Error ? err.message : err)
      return
    }

    if (!resp.ok) {
      console.warn(`[GuidedTaskState Sync] HTTP ${resp.status} pushing task ${taskId} — leaving pending for background retry`)
      try { incrementPendingRetry.run(`HTTP ${resp.status}`, subsystemId, taskId) } catch { /* best-effort */ }
      return
    }

    // Accepted — drop all pending rows for this task.
    try {
      deleteAllPendingForTask.run(subsystemId, taskId)
    } catch (err) {
      console.warn(`[GuidedTaskState Sync] Failed to clear pending for task ${taskId}:`, err instanceof Error ? err.message : err)
    }
  })
}
