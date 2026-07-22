import { db } from '@/lib/db-sqlite'
import type { PendingSync } from '@/lib/db-sqlite'

export interface CreatePendingSyncParams {
  ioId: number
  inspectorName?: string | null
  testResult?: string | null
  comments?: string | null
  state?: string | null
  timestamp?: string | null
  version?: number
}

/**
 * Repository for PendingSync (offline queue) operations (better-sqlite3)
 */
export const pendingSyncRepository = {
  /**
   * Create a new pending sync entry.
   *
   * Refuses null/empty testResult: the cloud handler interprets such a
   * payload as "set result to NULL", which caused the 2026-05-21 silent
   * test-loss incident (see commit 4f6b888 + frontend/app/api/ios/[id]/route.ts).
   * Callers must classify a comment-only change to one of the recognized
   * 'Comment …' ops before queueing.
   */
  create(params: CreatePendingSyncParams): PendingSync {
    if (params.testResult == null || params.testResult === '') {
      throw new Error(
        `pendingSyncRepository.create: refused null/empty testResult for ioId=${params.ioId}. ` +
          `Caller must classify the change to one of Passed | Failed | Cleared | "Comment Added/Removed/Modified".`,
      )
    }
    const result = db.prepare(
      'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, CreatedAt, RetryCount, Version) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(
      params.ioId,
      params.inspectorName ?? null,
      params.testResult,
      params.comments ?? null,
      params.state ?? null,
      params.timestamp ?? null,
      new Date().toISOString(),
      params.version ?? 0,
    )

    return db.prepare('SELECT * FROM PendingSyncs WHERE id = ?').get(result.lastInsertRowid) as PendingSync
  },

  /**
   * Get all pending syncs ordered by creation date
   */
  getAll(): PendingSync[] {
    return db.prepare('SELECT * FROM PendingSyncs ORDER BY CreatedAt ASC').all() as PendingSync[]
  },

  /**
   * Get pending syncs for a specific IO
   */
  getByIoId(ioId: number): PendingSync[] {
    return db.prepare('SELECT * FROM PendingSyncs WHERE IoId = ? ORDER BY CreatedAt ASC').all(ioId) as PendingSync[]
  },

  /**
   * Get next batch of ACTIVE pending syncs to process. Excludes dead-lettered
   * rows (cloud-rejected / retry-cap-exhausted) — those are parked, not
   * retried, but kept for the "needs attention" surface.
   */
  getNextBatch(batchSize: number): PendingSync[] {
    return db.prepare('SELECT * FROM PendingSyncs WHERE DeadLettered = 0 ORDER BY CreatedAt ASC LIMIT ?').all(batchSize) as PendingSync[]
  },

  /**
   * Park a row that must NOT be retried but must NOT be lost: the cloud
   * permanently rejected it (e.g. SPARE cannot be Passed) or it exhausted the
   * retry cap. Keeps the row + reason so the indicator can surface it as
   * "needs attention" instead of the result silently vanishing (B3/B5/B7).
   */
  deadLetter(id: number, reason: string): void {
    db.prepare('UPDATE PendingSyncs SET DeadLettered = 1, LastError = ? WHERE id = ?').run(reason, id)
  },

  /**
   * ORPHAN a row: the cloud target (IO) was CONFIRMED removed — a 403/404/410
   * write rejection or an IO delete-tombstone from the delta. This is a strict
   * SUBSET of deadLetter (Orphaned=1 ⇒ DeadLettered=1) that additionally marks
   * the row as "removed on cloud" so it (a) drops out of the amber attention
   * badge and (b) auto-requeues (Orphaned→0, DeadLettered→0) if the IO ever
   * reappears via a delta upsert — with its local value fully intact.
   *
   * Orphaning is also TERMINAL: the same statement marks the row Resolved
   * (Resolved=1 ⇒ Orphaned=1) with a timestamp + reason. The cloud has proved
   * the target is gone, so there is nothing left for a human to decide — the row
   * leaves every attention count, the heartbeat, and the Sync Center's default
   * view rather than accumulating in the "removed on cloud" tab forever.
   * RESOLVED ≠ DELETED: the TestResult/Comments/State survive untouched and stay
   * queryable, and delta-sync clears Resolved if the IO ever comes back.
   *
   * RetryCount is reset to 0 so a later reappearance+requeue starts clean.
   * NEVER call this on a network/transient failure, a version conflict
   * (updatedCount=0), or a retry-cap park — those keep plain deadLetter/retry
   * behaviour. QUEUE-ROW FLAG ONLY — never touches the Ios value.
   */
  orphan(id: number, reason: string): void {
    db.prepare(
      'UPDATE PendingSyncs SET DeadLettered = 1, Orphaned = 1, Resolved = 1, ResolvedAt = ?, ResolvedReason = ?, LastError = ?, RetryCount = 0 WHERE id = ?',
    ).run(new Date().toISOString(), reason, reason, id)
    // Tombstone the underlying IO (CloudRemoved=1). A cloud-removed result must
    // (a) stop tripping the pull-guard "would erase" diff, which reads Ios
    // directly and warned forever, and (b) stop being re-queued by the orphan
    // reconciler after the operator discards its queue row — the
    // discard→reconcile→404→orphan loop. Cleared back to 0 by delta-sync when the
    // IO reappears via a cloud upsert (device restored), mirroring the Orphaned
    // flag's auto-requeue. This is a SYNC-STATE flag only — the test
    // Result/Comments VALUE is never touched (preserved for a later reappearance).
    db.prepare(
      'UPDATE Ios SET CloudRemoved = 1 WHERE id = (SELECT IoId FROM PendingSyncs WHERE id = ?)',
    ).run(id)
  },

  /**
   * Count of rows parked for attention (cloud-rejected / cap-exhausted).
   * Excludes Resolved rows — those reached a terminal state (their cloud target
   * is provably gone) and must never be counted as something a human owes work on.
   */
  countDeadLettered(): number {
    return (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs WHERE DeadLettered = 1 AND Resolved = 0').get() as any).count
  },

  /**
   * Get pending syncs that have failed (retryCount > 0)
   */
  getFailed(): PendingSync[] {
    return db.prepare('SELECT * FROM PendingSyncs WHERE RetryCount > 0 ORDER BY CreatedAt ASC').all() as PendingSync[]
  },

  /**
   * Increment retry count and set last error.
   *
   * Only call this when the CLOUD gave a verdict on the row (e.g.
   * updatedCount=0 / version mismatch). For network-level failures use
   * recordTransientFailure — counting offline timeouts as strikes is what
   * emptied the queue in the 2026-06-04 TPA8/MCM08 data-loss incident.
   */
  recordFailure(id: number, error: string): PendingSync {
    db.prepare(
      'UPDATE PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?'
    ).run(error, id)
    return db.prepare('SELECT * FROM PendingSyncs WHERE id = ?').get(id) as PendingSync
  },

  /**
   * Record a network-level failure WITHOUT burning a retry-cap strike.
   * The row is still good — it just couldn't reach the cloud (offline,
   * timeout, proxy 5xx, auth misconfig). Keeps LastError fresh for
   * diagnostics.
   */
  recordTransientFailure(id: number, error: string): void {
    db.prepare('UPDATE PendingSyncs SET LastError = ? WHERE id = ?').run(error, id)
  },

  /**
   * Delete a pending sync (after successful sync)
   */
  delete(id: number): void {
    db.prepare('DELETE FROM PendingSyncs WHERE id = ?').run(id)
  },

  /**
   * Delete multiple pending syncs by IDs
   */
  deleteMany(ids: number[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const result = db.prepare(`DELETE FROM PendingSyncs WHERE id IN (${placeholders})`).run(...ids)
    return result.changes
  },

  /**
   * Delete all pending syncs for an IO
   */
  deleteByIoId(ioId: number): number {
    const result = db.prepare('DELETE FROM PendingSyncs WHERE IoId = ?').run(ioId)
    return result.changes
  },

  /**
   * Delete all pending syncs
   */
  deleteAll(): number {
    const result = db.prepare('DELETE FROM PendingSyncs').run()
    return result.changes
  },

  /**
   * Count of ACTIVE pending syncs (work still to be delivered to cloud).
   * Excludes dead-lettered rows so the "unsynced" badge reflects retryable
   * work, while attention rows are surfaced separately (countDeadLettered).
   */
  count(): number {
    return (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs WHERE DeadLettered = 0').get() as any).count
  },

  /**
   * Check if there are any pending syncs
   */
  hasPending(): boolean {
    return this.count() > 0
  },

  /**
   * Get oldest pending sync
   */
  getOldest(): PendingSync | null {
    return (db.prepare('SELECT * FROM PendingSyncs ORDER BY CreatedAt ASC LIMIT 1').get() as PendingSync | undefined) ?? null
  },

  /**
   * Get pending syncs with high retry count (potential permanent failures)
   */
  getHighRetryCount(threshold: number = 5): PendingSync[] {
    return db.prepare(
      'SELECT * FROM PendingSyncs WHERE RetryCount >= ? ORDER BY RetryCount DESC'
    ).all(threshold) as PendingSync[]
  },

  /**
   * Reset retry count for a pending sync
   */
  resetRetryCount(id: number): PendingSync {
    db.prepare('UPDATE PendingSyncs SET RetryCount = 0, LastError = NULL WHERE id = ?').run(id)
    return db.prepare('SELECT * FROM PendingSyncs WHERE id = ?').get(id) as PendingSync
  },

  /**
   * Get statistics about pending syncs
   */
  getStats(): {
    total: number
    failed: number
    maxRetries: number
    oldestTimestamp: string | null
  } {
    const total = this.count()
    const failed = (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs WHERE RetryCount > 0').get() as any).count
    const oldest = db.prepare('SELECT CreatedAt FROM PendingSyncs ORDER BY CreatedAt ASC LIMIT 1').get() as { CreatedAt: string } | undefined
    const maxRetryRecord = db.prepare('SELECT RetryCount FROM PendingSyncs ORDER BY RetryCount DESC LIMIT 1').get() as { RetryCount: number } | undefined

    return {
      total,
      failed,
      maxRetries: maxRetryRecord?.RetryCount ?? 0,
      oldestTimestamp: oldest?.CreatedAt ?? null,
    }
  },
}

export default pendingSyncRepository
