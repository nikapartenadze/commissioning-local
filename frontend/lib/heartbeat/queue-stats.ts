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

/**
 * QUEUE-AGE WATCHDOG threshold, in minutes.
 *
 * The outbound queue is supposed to be a few MINUTES deep: auto-sync drains it
 * every 10 s, and a row that cannot be delivered is parked or orphaned within
 * its retry cap. An ACTIVE row older than this is therefore ABNORMAL by
 * definition — it is neither draining nor reaching a terminal state, which is
 * the exact silent-limbo shape that hid the deleted-IO backlog for months.
 *
 * 15 minutes is deliberately generous: it clears a site that has been offline
 * for a coffee break, but not one where work is genuinely not moving.
 *
 * This is a SYMPTOM DETECTOR, not a remediation. Nothing auto-deletes or
 * auto-resolves on the strength of age alone — an old row means someone must
 * LOOK, and age is far too weak a signal to justify hiding field data. It is
 * reported so the cloud can raise it to a human.
 */
export const QUEUE_AGE_WATCHDOG_MINUTES = 15

export interface QueueStats {
  active: number
  parked: number
  /** Minutes the oldest ACTIVE row has been waiting; 0 when the queue is empty. */
  oldestPendingAgeMin: number
  /**
   * ACTIVE rows older than `staleThresholdMin` — work that is neither draining
   * nor terminating. Non-zero means the queue needs adjudication, NOT that
   * anything has been (or should be) cleared. Counted across all five queues.
   */
  staleActive: number
  /** The threshold `staleActive` was computed against, so the cloud can read the number. */
  staleThresholdMin: number
  byQueue: Record<string, { active: number; parked: number }>
}

export function collectQueueStats(now: Date = new Date()): QueueStats {
  const byQueue: QueueStats['byQueue'] = {}
  let active = 0
  let parked = 0
  let staleActive = 0
  let oldest: number | null = null
  // Cutoff computed against the SAME `now` the ages are reported against, in
  // SQLite's own 'YYYY-MM-DD HH:MM:SS' UTC shape.
  //
  // Compared via julianday(), NOT as text: CreatedAt exists in BOTH the SQLite
  // datetime('now') form ('2026-07-22 10:00:00') and the ISO form the repository
  // writes ('2026-07-22T10:00:00.000Z'). Those two do not sort against each
  // other as strings ('T' > ' '), so a text comparison would silently misjudge
  // every ISO row. julianday parses both as UTC and yields NULL (never a false
  // hit) on anything it cannot read.
  const cutoff = new Date(now.getTime() - QUEUE_AGE_WATCHDOG_MINUTES * 60_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19)
  for (const table of QUEUES) {
    try {
      // Resolved rows are terminal (cloud target provably removed) — they are
      // excluded from BOTH legs so the fleet-alert sweep never reports a tablet
      // as having stuck work that no human can or should clear. Resolved ⇒
      // DeadLettered, so only the `parked` leg can actually match one.
      const row = db.prepare(
        `SELECT
           SUM(CASE WHEN DeadLettered = 0 AND Resolved = 0 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN DeadLettered = 1 AND Resolved = 0 THEN 1 ELSE 0 END) AS parked,
           MIN(CASE WHEN DeadLettered = 0 AND Resolved = 0 THEN CreatedAt END) AS oldest,
           SUM(CASE WHEN DeadLettered = 0 AND Resolved = 0
                     AND julianday(CreatedAt) < julianday(?) THEN 1 ELSE 0 END) AS stale
         FROM ${table}`,
      ).get(cutoff) as { active: number | null; parked: number | null; oldest: string | null; stale: number | null }
      const a = row.active ?? 0
      const p = row.parked ?? 0
      byQueue[table] = { active: a, parked: p }
      active += a
      parked += p
      staleActive += row.stale ?? 0
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
    staleActive,
    staleThresholdMin: QUEUE_AGE_WATCHDOG_MINUTES,
    byQueue,
  }
}
