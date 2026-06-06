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

  /** Count of rows parked for attention (cloud-rejected / cap-exhausted). */
  countDeadLettered(): number {
    return (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs WHERE DeadLettered = 1').get() as any).count
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
