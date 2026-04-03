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
   * Create a new pending sync entry
   */
  create(params: CreatePendingSyncParams): PendingSync {
    const result = db.prepare(
      'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, CreatedAt, RetryCount, Version) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(
      params.ioId,
      params.inspectorName ?? null,
      params.testResult ?? null,
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
   * Get next batch of pending syncs to process
   */
  getNextBatch(batchSize: number): PendingSync[] {
    return db.prepare('SELECT * FROM PendingSyncs ORDER BY CreatedAt ASC LIMIT ?').all(batchSize) as PendingSync[]
  },

  /**
   * Get pending syncs that have failed (retryCount > 0)
   */
  getFailed(): PendingSync[] {
    return db.prepare('SELECT * FROM PendingSyncs WHERE RetryCount > 0 ORDER BY CreatedAt ASC').all() as PendingSync[]
  },

  /**
   * Increment retry count and set last error
   */
  recordFailure(id: number, error: string): PendingSync {
    db.prepare(
      'UPDATE PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?'
    ).run(error, id)
    return db.prepare('SELECT * FROM PendingSyncs WHERE id = ?').get(id) as PendingSync
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
   * Get count of pending syncs
   */
  count(): number {
    return (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs').get() as any).count
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
