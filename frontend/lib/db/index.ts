/**
 * Database module — re-exports from db-sqlite for backward compatibility.
 *
 * All DB calls are synchronous (better-sqlite3).
 */

import { db, Io, TestHistory, User, PendingSync, TestConstants, checkDatabaseHealth, ioToApi } from '@/lib/db-sqlite'

// Re-export the db instance as both `db` and `prisma` (for files that still import prisma from here)
export { db, db as prisma }

// Re-export types
export type { Io, TestHistory, User, PendingSync }

// Re-export type aliases that match Prisma-era names
export type TagTypeDiagnostic = {
  TagType: string
  FailureMode: string
  DiagnosticSteps: string
  CreatedAt: string | null
  UpdatedAt: string | null
}

export { TestConstants, ioToApi }

// Helper type for IO with computed properties
export interface IoWithComputed extends Io {
  isOutput: boolean
  hasResult: boolean
  isPassed: boolean
  isFailed: boolean
}

// Add computed properties to IO
export function enrichIo(io: Io): IoWithComputed {
  const name = io.Name ?? ''
  return {
    ...io,
    isOutput:
      name.includes(':O.') ||
      name.includes(':SO.') ||
      name.includes('.O.') ||
      name.includes(':O:') ||
      name.includes('.Outputs.') ||
      name.endsWith('.DO'),
    hasResult: !!io.Result,
    isPassed: io.Result === TestConstants.RESULT_PASSED,
    isFailed: io.Result === TestConstants.RESULT_FAILED,
  }
}

// Helper type for TestHistory with computed properties
export interface TestHistoryWithComputed extends TestHistory {
  timestampAsDate: Date | null
  isPassed: boolean
  isFailed: boolean
}

// Add computed properties to TestHistory
export function enrichTestHistory(history: TestHistory): TestHistoryWithComputed {
  const date = history.Timestamp ? new Date(history.Timestamp) : null
  return {
    ...history,
    timestampAsDate: date && !isNaN(date.getTime()) ? date : null,
    isPassed: history.Result === TestConstants.RESULT_PASSED,
    isFailed: history.Result === TestConstants.RESULT_FAILED,
  }
}

// Common query helpers

/**
 * Get count of IOs grouped by result status
 */
export function getIoStatusCounts(subsystemId?: number) {
  if (subsystemId) {
    const total = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ?').get(subsystemId) as any).count
    const passed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ? AND Result = ?').get(subsystemId, TestConstants.RESULT_PASSED) as any).count
    const failed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ? AND Result = ?').get(subsystemId, TestConstants.RESULT_FAILED) as any).count
    const untested = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ? AND Result IS NULL').get(subsystemId) as any).count
    return { total, passed, failed, untested }
  }

  const total = (db.prepare('SELECT COUNT(*) as count FROM Ios').get() as any).count
  const passed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE Result = ?').get(TestConstants.RESULT_PASSED) as any).count
  const failed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE Result = ?').get(TestConstants.RESULT_FAILED) as any).count
  const untested = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE Result IS NULL').get() as any).count
  return { total, passed, failed, untested }
}

/**
 * Get pending sync count
 */
export function getPendingSyncCount(): number {
  return (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs').get() as any).count
}

/**
 * Check if database connection is healthy
 */
export { checkDatabaseHealth }

/**
 * Disconnect — no-op for better-sqlite3 (connection is per-process)
 */
export function disconnect(): void {
  // better-sqlite3 doesn't need explicit disconnect in typical usage
}
