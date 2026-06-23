/**
 * IO Test Service
 *
 * Port of the C# IoTestService to TypeScript.
 * Handles recording test results (Pass/Fail/Reset), creating TestHistory audit records,
 * queuing results for cloud sync, and handling order mode (sequential testing).
 */

import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags } from '../plc-client-manager'
import { checkInstallGate } from './install-gate'
import { getTagForIo, hasAnyMcm } from '../mcm-registry'

// Test result constants (matching C# TestConstants)
export const TEST_CONSTANTS = {
  RESULT_PASSED: 'Passed',
  RESULT_FAILED: 'Failed',
  RESULT_CLEARED: 'Cleared',
  RESULT_ADDRESSED: 'Addressed',
  RESULT_NOT_TESTED: 'Not Tested',
  RESULT_COMMENT_ADDED: 'Comment Added',
  RESULT_COMMENT_REMOVED: 'Comment Removed',
  RESULT_COMMENT_MODIFIED: 'Comment Modified',
  RESULT_COMMENT_UPDATED: 'Comment Updated',
  TIMESTAMP_FORMAT: 'MM/dd/yy h:mm:ss.fff a', // JavaScript date format
} as const

// Types
export interface IoWithState {
  id: number
  SubsystemId: number
  Name: string | null
  Description: string | null
  Result: string | null
  Timestamp: string | null
  Comments: string | null
  Order: number | null
  Version: number
  TagType?: string | null
  CloudSyncedAt?: string | null
  NetworkDeviceName?: string | null
  state?: string
}

export interface TestResultRequest {
  comments?: string
  currentUser?: string
  failureMode?: string
}

export interface CommentUpdateResult {
  success: boolean
  changesWereMade: boolean
  errorMessage?: string
}

export interface IoUpdateDto {
  id: number
  result?: string | null
  timestamp?: string | null
  comments?: string | null
  testedBy?: string
  state?: string
  version?: number
}

/**
 * Sanitize comment by removing HTML tags
 */
export function sanitizeComment(input: string | null | undefined): string | null {
  if (!input) return input ?? null
  return input.replace(/<[^>]*>/g, '')
}

/**
 * Create a timestamp in the standard format
 */
export function createTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Get current PLC state for an IO by ID.
 *
 * Multi-MCM aware — if any MCM is registered (central-tool path), we resolve
 * the tag through mcm-registry so each IO addresses its owning controller.
 * If the registry is empty we fall back to the legacy single-PLC singleton.
 */
export function getPlcStateForIo(ioId: number): string | undefined {
  if (hasAnyMcm()) {
    const tag = getTagForIo(ioId)
    if (tag) return tag.state ?? undefined
    // intentional fall-through: registry knows nothing about this IO yet
    // (e.g. tags not loaded for the owning MCM), so try the singleton too
  }
  const { tags } = getPlcTags()
  const tag = tags.find(t => t.id === ioId)
  return tag?.state
}

/**
 * Get the next untested IO in order mode
 */
export function getNextUntestedIo(subsystemId: number): IoWithState | null {
  const io = db.prepare(
    'SELECT * FROM Ios WHERE SubsystemId = ? AND Result IS NULL ORDER BY "Order" ASC LIMIT 1'
  ).get(subsystemId) as Io | undefined

  if (!io) return null

  return {
    ...io,
    state: getPlcStateForIo(io.id)
  }
}

// Keep async signature for backward compat
export async function getNextUntestedIoAsync(subsystemId: number): Promise<IoWithState | null> {
  return getNextUntestedIo(subsystemId)
}

/**
 * Mark an IO test as passed
 */
export async function markTestPassedAsync(
  ioId: number,
  options: TestResultRequest = {}
): Promise<{ success: boolean; error?: string }> {
  return updateTestResult(ioId, TEST_CONSTANTS.RESULT_PASSED, options)
}

/**
 * Mark an IO test as failed
 */
export async function markTestFailedAsync(
  ioId: number,
  options: TestResultRequest = {}
): Promise<{ success: boolean; error?: string }> {
  return updateTestResult(ioId, TEST_CONSTANTS.RESULT_FAILED, options)
}

/**
 * Clear/reset an IO test result
 */
export async function clearTestResultAsync(
  ioId: number,
  currentUser: string = 'Unknown'
): Promise<{ success: boolean; error?: string }> {
  try {
    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return { success: false, error: 'IO not found' }
    }

    // Check if already cleared
    const hadComments = !!io.Comments
    const hadResult = !!io.Result

    if (!hadComments && !hadResult) {
      // Already cleared, nothing to do
      return { success: true }
    }

    // Build history comment
    let historyComment: string | null = null
    if (hadResult && hadComments) {
      historyComment = io.Comments
    } else if (hadResult) {
      historyComment = `Cleared ${io.Result} result`
    } else {
      historyComment = 'Cleared comments'
    }

    const plcState = getPlcStateForIo(ioId)
    const timestamp = createTimestamp()

    // Use transaction for atomicity
    const clearTransaction = db.transaction(() => {
      db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(ioId, TEST_CONSTANTS.RESULT_CLEARED, timestamp, historyComment, plcState ?? null, currentUser)

      db.prepare(
        'UPDATE Ios SET Result = NULL, Timestamp = NULL, Comments = NULL, Version = Version + 1 WHERE id = ?'
      ).run(ioId)
    })

    clearTransaction()

    return { success: true }
  } catch (error) {
    console.error('Error clearing test result:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Update comment for an IO
 */
export async function updateCommentAsync(
  ioId: number,
  newComment: string,
  currentUser: string = 'Unknown'
): Promise<CommentUpdateResult> {
  try {
    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return { success: false, changesWereMade: false, errorMessage: 'IO not found' }
    }

    const oldComment = io.Comments ?? ''
    const normalizedNew = newComment ?? ''

    // No change needed
    if (oldComment === normalizedNew) {
      return { success: true, changesWereMade: false }
    }

    const plcState = getPlcStateForIo(ioId)
    const timestamp = createTimestamp()
    const { historyResult, historyComment } = determineCommentChange(oldComment, normalizedNew)

    // Use transaction for atomicity
    const commentTransaction = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Comments = ?, Timestamp = ?, Version = Version + 1 WHERE id = ?'
      ).run(normalizedNew, timestamp, ioId)

      db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(ioId, historyResult, timestamp, historyComment, plcState ?? null, currentUser)
    })

    commentTransaction()

    return { success: true, changesWereMade: true }
  } catch (error) {
    console.error('Error updating comment:', error)
    return {
      success: false,
      changesWereMade: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Get IO by ID with current PLC state
 */
export function getIoById(ioId: number): IoWithState | null {
  const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

  if (!io) return null

  return {
    ...io,
    state: getPlcStateForIo(io.id)
  }
}

// Keep async signature for backward compat
export async function getIoByIdAsync(ioId: number): Promise<IoWithState | null> {
  return getIoById(ioId)
}

/**
 * Get all IOs for a subsystem with current PLC states. Routes through
 * mcm-registry first when populated so each IO's state comes from the right
 * controller; falls back to the legacy singleton's tag list otherwise.
 */
export function getIosBySubsystem(subsystemId: number): IoWithState[] {
  const ios = db.prepare(
    'SELECT * FROM Ios WHERE SubsystemId = ? ORDER BY "Order" ASC'
  ).all(subsystemId) as Io[]

  return ios.map(io => ({
    ...io,
    state: getPlcStateForIo(io.id)
  }))
}

// Keep async signature for backward compat
export async function getIosBySubsystemAsync(subsystemId: number): Promise<IoWithState[]> {
  return getIosBySubsystem(subsystemId)
}

/**
 * Get test statistics for a subsystem
 */
export function getTestStats(subsystemId?: number): {
  total: number
  passed: number
  failed: number
  untested: number
} {
  if (subsystemId) {
    const total = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ?').get(subsystemId) as any).count
    const passed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ? AND Result = ?').get(subsystemId, TEST_CONSTANTS.RESULT_PASSED) as any).count
    const failed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ? AND Result = ?').get(subsystemId, TEST_CONSTANTS.RESULT_FAILED) as any).count
    return { total, passed, failed, untested: total - passed - failed }
  }

  const total = (db.prepare('SELECT COUNT(*) as count FROM Ios').get() as any).count
  const passed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE Result = ?').get(TEST_CONSTANTS.RESULT_PASSED) as any).count
  const failed = (db.prepare('SELECT COUNT(*) as count FROM Ios WHERE Result = ?').get(TEST_CONSTANTS.RESULT_FAILED) as any).count
  return { total, passed, failed, untested: total - passed - failed }
}

// Keep async signature for backward compat
export async function getTestStatsAsync(subsystemId?: number): Promise<{
  total: number
  passed: number
  failed: number
  untested: number
}> {
  return getTestStats(subsystemId)
}

/**
 * Get test history for an IO
 */
export function getTestHistory(ioId: number, limit: number = 100) {
  return db.prepare(
    'SELECT * FROM TestHistories WHERE IoId = ? ORDER BY Timestamp DESC LIMIT ?'
  ).all(ioId, limit)
}

// Keep async signature for backward compat
export async function getTestHistoryAsync(ioId: number, limit: number = 100) {
  return getTestHistory(ioId, limit)
}

// Private helper functions

function updateTestResult(
  ioId: number,
  result: string,
  options: TestResultRequest = {}
): { success: boolean; error?: string } {
  try {
    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return { success: false, error: 'IO not found' }
    }

    // Server-side authoritative gate. The UI also disables the buttons, but
    // a stale client / direct API hit would bypass that — this is the only
    // place that's safe.
    const gate = checkInstallGate(io)
    if (!gate.allowed) {
      return { success: false, error: gate.error }
    }

    const sanitizedComments = sanitizeComment(options.comments) ?? null
    const plcState = getPlcStateForIo(ioId)
    const timestamp = createTimestamp()

    // Use transaction for atomicity
    const testTransaction = db.transaction(() => {
      // A new Pass/Fail result is a re-test outcome — it supersedes any resolver
      // workflow state (Addressed / Clarification), so clear it. This is what
      // moves a re-checked item out of the Addressed bucket back to Pass/Fail.
      db.prepare(
        'UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ?, PunchlistStatus = NULL, ClarificationNote = NULL, Version = Version + 1 WHERE id = ?'
      ).run(result, timestamp, sanitizedComments, ioId)

      db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy, FailureMode) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, result, timestamp, io.Comments, plcState ?? null, options.currentUser ?? 'Unknown', options.failureMode || null)
    })

    testTransaction()

    return { success: true }
  } catch (error) {
    console.error('Error updating test result:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

function determineCommentChange(
  oldComment: string | null | undefined,
  newComment: string | null | undefined
): { historyResult: string; historyComment: string } {
  const normalizedOld = oldComment ?? ''
  const normalizedNew = newComment ?? ''

  const historyResult = determineCommentChangeType(normalizedOld, normalizedNew)
  const historyComment = createCommentHistoryText(normalizedOld, normalizedNew)

  return { historyResult, historyComment }
}

function determineCommentChangeType(oldComment: string, newComment: string): string {
  if (!oldComment && newComment) {
    return TEST_CONSTANTS.RESULT_COMMENT_ADDED
  }
  if (oldComment && !newComment) {
    return TEST_CONSTANTS.RESULT_COMMENT_REMOVED
  }
  if (oldComment !== newComment) {
    return TEST_CONSTANTS.RESULT_COMMENT_MODIFIED
  }
  return TEST_CONSTANTS.RESULT_COMMENT_UPDATED
}

function createCommentHistoryText(oldComment: string, newComment: string): string {
  // If both are empty, no history text needed
  if (!oldComment && !newComment) {
    return ''
  }

  if (!oldComment && newComment) {
    return newComment
  }

  if (oldComment && !newComment) {
    return `Previous comment: ${oldComment}`
  }

  if (oldComment !== newComment) {
    return `New: ${newComment} (Previous: ${oldComment})`
  }

  return newComment
}
