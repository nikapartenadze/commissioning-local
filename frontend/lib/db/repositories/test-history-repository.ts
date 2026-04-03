import { db } from '@/lib/db-sqlite'
import type { TestHistory } from '@/lib/db-sqlite'
import { enrichTestHistory, TestHistoryWithComputed, TestConstants } from '../index'

export interface CreateTestHistoryParams {
  ioId: number
  result: string
  state?: string | null
  comments?: string | null
  testedBy?: string | null
  failureMode?: string | null
  timestamp?: string
}

export interface TestHistoryFilters {
  ioId?: number
  result?: string
  testedBy?: string
  failureMode?: string
  fromDate?: Date
  toDate?: Date
}

/**
 * Repository for TestHistory CRUD operations (better-sqlite3)
 */
export const testHistoryRepository = {
  /**
   * Create a test history record
   */
  create(params: CreateTestHistoryParams): TestHistoryWithComputed {
    const timestamp = params.timestamp ?? new Date().toISOString()

    const result = db.prepare(
      'INSERT INTO TestHistories (IoId, Result, State, Comments, TestedBy, FailureMode, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      params.ioId,
      params.result,
      params.state ?? null,
      params.comments ?? null,
      params.testedBy ?? null,
      params.failureMode ?? null,
      timestamp,
    )

    const history = db.prepare('SELECT * FROM TestHistories WHERE id = ?').get(result.lastInsertRowid) as TestHistory
    return enrichTestHistory(history)
  },

  /**
   * Get test history by ID
   */
  getById(id: number): TestHistoryWithComputed | null {
    const history = db.prepare('SELECT * FROM TestHistories WHERE id = ?').get(id) as TestHistory | undefined
    return history ? enrichTestHistory(history) : null
  },

  /**
   * Get all history for an IO
   */
  getByIoId(ioId: number): TestHistoryWithComputed[] {
    const histories = db.prepare(
      'SELECT * FROM TestHistories WHERE IoId = ? ORDER BY Timestamp DESC'
    ).all(ioId) as TestHistory[]

    return histories.map(enrichTestHistory)
  },

  /**
   * Get latest history entry for an IO
   */
  getLatestForIo(ioId: number): TestHistoryWithComputed | null {
    const history = db.prepare(
      'SELECT * FROM TestHistories WHERE IoId = ? ORDER BY Timestamp DESC LIMIT 1'
    ).get(ioId) as TestHistory | undefined

    return history ? enrichTestHistory(history) : null
  },

  /**
   * Get all test history with optional filtering
   */
  getAll(filters?: TestHistoryFilters, limit?: number): TestHistoryWithComputed[] {
    const conditions: string[] = []
    const params: any[] = []

    if (filters?.ioId) {
      conditions.push('IoId = ?')
      params.push(filters.ioId)
    }

    if (filters?.result) {
      conditions.push('Result = ?')
      params.push(filters.result)
    }

    if (filters?.testedBy) {
      conditions.push('TestedBy LIKE ?')
      params.push(`%${filters.testedBy}%`)
    }

    if (filters?.failureMode) {
      conditions.push('FailureMode = ?')
      params.push(filters.failureMode)
    }

    if (filters?.fromDate) {
      conditions.push('Timestamp >= ?')
      params.push(filters.fromDate.toISOString())
    }

    if (filters?.toDate) {
      conditions.push('Timestamp <= ?')
      params.push(filters.toDate.toISOString())
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limitClause = limit ? `LIMIT ${limit}` : ''

    const histories = db.prepare(
      `SELECT * FROM TestHistories ${where} ORDER BY Timestamp DESC ${limitClause}`
    ).all(...params) as TestHistory[]

    return histories.map(enrichTestHistory)
  },

  /**
   * Get history with IO details
   */
  getWithIo(id: number) {
    const history = db.prepare('SELECT * FROM TestHistories WHERE id = ?').get(id) as TestHistory | undefined
    if (!history) return null

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(history.IoId)
    return {
      ...enrichTestHistory(history),
      io,
    }
  },

  /**
   * Get recent test history
   */
  getRecent(limit: number = 50): TestHistoryWithComputed[] {
    const histories = db.prepare(
      'SELECT * FROM TestHistories ORDER BY Timestamp DESC LIMIT ?'
    ).all(limit) as TestHistory[]

    return histories.map(enrichTestHistory)
  },

  /**
   * Get test history grouped by tester
   */
  getCountByTester(): { testedBy: string; count: number }[] {
    const rows = db.prepare(
      'SELECT TestedBy, COUNT(*) as count FROM TestHistories WHERE TestedBy IS NOT NULL GROUP BY TestedBy'
    ).all() as { TestedBy: string; count: number }[]

    return rows.map(r => ({
      testedBy: r.TestedBy ?? 'Unknown',
      count: r.count,
    }))
  },

  /**
   * Get test history counts by result
   */
  getCountByResult(): { result: string; count: number }[] {
    const rows = db.prepare(
      'SELECT Result, COUNT(*) as count FROM TestHistories GROUP BY Result'
    ).all() as { Result: string; count: number }[]

    return rows.map(r => ({
      result: r.Result ?? 'Unknown',
      count: r.count,
    }))
  },

  /**
   * Get failure modes distribution
   */
  getFailureModeDistribution(): { failureMode: string; count: number }[] {
    const rows = db.prepare(
      'SELECT FailureMode, COUNT(*) as count FROM TestHistories WHERE FailureMode IS NOT NULL AND Result = ? GROUP BY FailureMode'
    ).all(TestConstants.RESULT_FAILED) as { FailureMode: string; count: number }[]

    return rows.map(r => ({
      failureMode: r.FailureMode ?? 'Unknown',
      count: r.count,
    }))
  },

  /**
   * Delete history by ID
   */
  delete(id: number): void {
    db.prepare('DELETE FROM TestHistories WHERE id = ?').run(id)
  },

  /**
   * Delete all history for an IO
   */
  deleteByIoId(ioId: number): number {
    const result = db.prepare('DELETE FROM TestHistories WHERE IoId = ?').run(ioId)
    return result.changes
  },

  /**
   * Delete all test history
   */
  deleteAll(): number {
    const result = db.prepare('DELETE FROM TestHistories').run()
    return result.changes
  },

  /**
   * Get total count
   */
  count(filters?: TestHistoryFilters): number {
    const conditions: string[] = []
    const params: any[] = []

    if (filters?.ioId) {
      conditions.push('IoId = ?')
      params.push(filters.ioId)
    }

    if (filters?.result) {
      conditions.push('Result = ?')
      params.push(filters.result)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return (db.prepare(`SELECT COUNT(*) as count FROM TestHistories ${where}`).get(...params) as any).count
  },

  /**
   * Check if IO has any test history
   */
  hasHistory(ioId: number): boolean {
    return (db.prepare('SELECT COUNT(*) as count FROM TestHistories WHERE IoId = ?').get(ioId) as any).count > 0
  },
}

export default testHistoryRepository
