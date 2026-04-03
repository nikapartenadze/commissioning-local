import { db } from '@/lib/db-sqlite'
import type { TagTypeDiagnostic } from '../index'

export interface CreateDiagnosticParams {
  tagType: string
  failureMode: string
  diagnosticSteps: string
}

export interface UpdateDiagnosticParams {
  diagnosticSteps?: string
}

/**
 * Repository for TagTypeDiagnostic operations (better-sqlite3)
 */
export const tagTypeDiagnosticRepository = {
  /**
   * Create a new diagnostic entry
   */
  create(params: CreateDiagnosticParams): TagTypeDiagnostic {
    db.prepare(
      'INSERT INTO TagTypeDiagnostics (TagType, FailureMode, DiagnosticSteps, CreatedAt) VALUES (?, ?, ?, ?)'
    ).run(params.tagType, params.failureMode, params.diagnosticSteps, new Date().toISOString())

    return db.prepare(
      'SELECT * FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?'
    ).get(params.tagType, params.failureMode) as TagTypeDiagnostic
  },

  /**
   * Get diagnostic by composite key (tagType + failureMode)
   */
  getByKey(tagType: string, failureMode: string): TagTypeDiagnostic | null {
    return (db.prepare(
      'SELECT * FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?'
    ).get(tagType, failureMode) as TagTypeDiagnostic | undefined) ?? null
  },

  /**
   * Get all diagnostics for a tag type
   */
  getByTagType(tagType: string): TagTypeDiagnostic[] {
    return db.prepare(
      'SELECT * FROM TagTypeDiagnostics WHERE TagType = ? ORDER BY FailureMode ASC'
    ).all(tagType) as TagTypeDiagnostic[]
  },

  /**
   * Get all diagnostics for a failure mode
   */
  getByFailureMode(failureMode: string): TagTypeDiagnostic[] {
    return db.prepare(
      'SELECT * FROM TagTypeDiagnostics WHERE FailureMode = ? ORDER BY TagType ASC'
    ).all(failureMode) as TagTypeDiagnostic[]
  },

  /**
   * Get all diagnostics
   */
  getAll(): TagTypeDiagnostic[] {
    return db.prepare(
      'SELECT * FROM TagTypeDiagnostics ORDER BY TagType ASC, FailureMode ASC'
    ).all() as TagTypeDiagnostic[]
  },

  /**
   * Update diagnostic steps
   */
  update(tagType: string, failureMode: string, params: UpdateDiagnosticParams): TagTypeDiagnostic {
    db.prepare(
      'UPDATE TagTypeDiagnostics SET DiagnosticSteps = ?, UpdatedAt = ? WHERE TagType = ? AND FailureMode = ?'
    ).run(params.diagnosticSteps, new Date().toISOString(), tagType, failureMode)

    return db.prepare(
      'SELECT * FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?'
    ).get(tagType, failureMode) as TagTypeDiagnostic
  },

  /**
   * Create or update diagnostic (upsert)
   */
  upsert(params: CreateDiagnosticParams): TagTypeDiagnostic {
    const existing = db.prepare(
      'SELECT * FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?'
    ).get(params.tagType, params.failureMode)

    if (existing) {
      db.prepare(
        'UPDATE TagTypeDiagnostics SET DiagnosticSteps = ?, UpdatedAt = ? WHERE TagType = ? AND FailureMode = ?'
      ).run(params.diagnosticSteps, new Date().toISOString(), params.tagType, params.failureMode)
    } else {
      db.prepare(
        'INSERT INTO TagTypeDiagnostics (TagType, FailureMode, DiagnosticSteps, CreatedAt) VALUES (?, ?, ?, ?)'
      ).run(params.tagType, params.failureMode, params.diagnosticSteps, new Date().toISOString())
    }

    return db.prepare(
      'SELECT * FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?'
    ).get(params.tagType, params.failureMode) as TagTypeDiagnostic
  },

  /**
   * Delete diagnostic by composite key
   */
  delete(tagType: string, failureMode: string): void {
    db.prepare(
      'DELETE FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?'
    ).run(tagType, failureMode)
  },

  /**
   * Delete all diagnostics for a tag type
   */
  deleteByTagType(tagType: string): number {
    const result = db.prepare('DELETE FROM TagTypeDiagnostics WHERE TagType = ?').run(tagType)
    return result.changes
  },

  /**
   * Delete all diagnostics
   */
  deleteAll(): number {
    const result = db.prepare('DELETE FROM TagTypeDiagnostics').run()
    return result.changes
  },

  /**
   * Get distinct tag types
   */
  getDistinctTagTypes(): string[] {
    const rows = db.prepare(
      'SELECT DISTINCT TagType FROM TagTypeDiagnostics ORDER BY TagType ASC'
    ).all() as { TagType: string }[]
    return rows.map(r => r.TagType)
  },

  /**
   * Get distinct failure modes
   */
  getDistinctFailureModes(): string[] {
    const rows = db.prepare(
      'SELECT DISTINCT FailureMode FROM TagTypeDiagnostics ORDER BY FailureMode ASC'
    ).all() as { FailureMode: string }[]
    return rows.map(r => r.FailureMode)
  },

  /**
   * Search diagnostics by text
   */
  search(query: string): TagTypeDiagnostic[] {
    const pattern = `%${query}%`
    return db.prepare(
      'SELECT * FROM TagTypeDiagnostics WHERE TagType LIKE ? OR FailureMode LIKE ? OR DiagnosticSteps LIKE ? ORDER BY TagType ASC, FailureMode ASC'
    ).all(pattern, pattern, pattern) as TagTypeDiagnostic[]
  },

  /**
   * Get count of diagnostics
   */
  count(): number {
    return (db.prepare('SELECT COUNT(*) as count FROM TagTypeDiagnostics').get() as any).count
  },

  /**
   * Check if diagnostic exists
   */
  exists(tagType: string, failureMode: string): boolean {
    return (db.prepare(
      'SELECT COUNT(*) as count FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?'
    ).get(tagType, failureMode) as any).count > 0
  },

  /**
   * Bulk create or update diagnostics
   */
  bulkUpsert(diagnostics: CreateDiagnosticParams[]): number {
    const upsertTransaction = db.transaction(() => {
      let count = 0
      for (const d of diagnostics) {
        const existing = db.prepare(
          'SELECT 1 FROM TagTypeDiagnostics WHERE TagType = ? AND FailureMode = ?'
        ).get(d.tagType, d.failureMode)

        if (existing) {
          db.prepare(
            'UPDATE TagTypeDiagnostics SET DiagnosticSteps = ?, UpdatedAt = ? WHERE TagType = ? AND FailureMode = ?'
          ).run(d.diagnosticSteps, new Date().toISOString(), d.tagType, d.failureMode)
        } else {
          db.prepare(
            'INSERT INTO TagTypeDiagnostics (TagType, FailureMode, DiagnosticSteps, CreatedAt) VALUES (?, ?, ?, ?)'
          ).run(d.tagType, d.failureMode, d.diagnosticSteps, new Date().toISOString())
        }
        count++
      }
      return count
    })

    return upsertTransaction()
  },
}

export default tagTypeDiagnosticRepository
