import { db } from '@/lib/db-sqlite'

/**
 * Aggregate outbox-queue health across ALL FIVE pending-sync tables — shipped
 * in the heartbeat's systemInfo.queueStats so the cloud's fleet-alert sweep
 * (tool_stuck_queue) can see "work is not reaching the cloud" without anyone
 * reading the box's logs. Pre-2.43.1 the heartbeat only carried a flat IO+L2
 * pendingSyncCount; parked rows and queue age were invisible remotely.
 */

const QUEUES = [
  'PendingSyncs',
  'L2PendingSyncs',
  'EStopCheckPendingSyncs',
  'GuidedTaskStatePendingSyncs',
  'DeviceBlockerPendingSyncs',
] as const

export interface QueueStats {
  active: number
  parked: number
  /** Minutes the oldest ACTIVE row has been waiting; 0 when the queue is empty. */
  oldestPendingAgeMin: number
  byQueue: Record<string, { active: number; parked: number }>
}

export function collectQueueStats(now: Date = new Date()): QueueStats {
  const byQueue: QueueStats['byQueue'] = {}
  let active = 0
  let parked = 0
  let oldest: number | null = null
  for (const table of QUEUES) {
    try {
      const row = db.prepare(
        `SELECT
           SUM(CASE WHEN DeadLettered = 0 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN DeadLettered = 1 THEN 1 ELSE 0 END) AS parked,
           MIN(CASE WHEN DeadLettered = 0 THEN CreatedAt END) AS oldest
         FROM ${table}`,
      ).get() as { active: number | null; parked: number | null; oldest: string | null }
      const a = row.active ?? 0
      const p = row.parked ?? 0
      byQueue[table] = { active: a, parked: p }
      active += a
      parked += p
      if (row.oldest) {
        const t = Date.parse(`${row.oldest.replace(' ', 'T')}Z`) // SQLite datetime('now') is UTC without zone
        if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t
      }
    } catch {
      // table missing on an old DB — skip, never break the heartbeat
      byQueue[table] = { active: 0, parked: 0 }
    }
  }
  return {
    active,
    parked,
    oldestPendingAgeMin: oldest === null ? 0 : Math.max(0, Math.round((now.getTime() - oldest) / 60000)),
    byQueue,
  }
}
