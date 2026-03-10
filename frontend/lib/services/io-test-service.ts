/**
 * IO Test Service
 *
 * Port of the C# IoTestService to TypeScript.
 * Handles recording test results (Pass/Fail/Reset), creating TestHistory audit records,
 * queuing results for cloud sync, and handling order mode (sequential testing).
 */

import { prisma } from '../prisma'
import { getPlcTags } from '../plc-client-manager'

// Test result constants (matching C# TestConstants)
export const TEST_CONSTANTS = {
  RESULT_PASSED: 'Passed',
  RESULT_FAILED: 'Failed',
  RESULT_CLEARED: 'Cleared',
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
  subsystemId: number
  name: string | null
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  order: number | null
  version: bigint
  tagType?: string | null
  cloudSyncedAt?: Date | null
  networkDeviceName?: string | null
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
  version?: bigint
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
 * Get current PLC state for an IO by ID
 */
export function getPlcStateForIo(ioId: number): string | undefined {
  const { tags } = getPlcTags()
  const tag = tags.find(t => t.id === ioId)
  return tag?.state
}

/**
 * Get the next untested IO in order mode
 */
export async function getNextUntestedIoAsync(subsystemId: number): Promise<IoWithState | null> {
  const io = await prisma.io.findFirst({
    where: {
      subsystemId,
      result: null
    },
    orderBy: {
      order: 'asc'
    }
  })

  if (!io) return null

  return {
    ...io,
    state: getPlcStateForIo(io.id)
  }
}

/**
 * Mark an IO test as passed
 */
export async function markTestPassedAsync(
  ioId: number,
  options: TestResultRequest = {}
): Promise<{ success: boolean; error?: string }> {
  return updateTestResultAsync(ioId, TEST_CONSTANTS.RESULT_PASSED, options)
}

/**
 * Mark an IO test as failed
 */
export async function markTestFailedAsync(
  ioId: number,
  options: TestResultRequest = {}
): Promise<{ success: boolean; error?: string }> {
  return updateTestResultAsync(ioId, TEST_CONSTANTS.RESULT_FAILED, options)
}

/**
 * Clear/reset an IO test result
 */
export async function clearTestResultAsync(
  ioId: number,
  currentUser: string = 'Unknown'
): Promise<{ success: boolean; error?: string }> {
  try {
    const io = await prisma.io.findUnique({
      where: { id: ioId }
    })

    if (!io) {
      return { success: false, error: 'IO not found' }
    }

    // Check if already cleared
    const hadComments = !!io.comments
    const hadResult = !!io.result

    if (!hadComments && !hadResult) {
      // Already cleared, nothing to do
      return { success: true }
    }

    // Build history comment
    let historyComment: string | null = null
    if (hadResult && hadComments) {
      historyComment = io.comments
    } else if (hadResult) {
      historyComment = `Cleared ${io.result} result`
    } else {
      historyComment = 'Cleared comments'
    }

    const plcState = getPlcStateForIo(ioId)
    const timestamp = createTimestamp()

    // Use transaction for atomicity
    await prisma.$transaction(async (tx) => {
      // Create history record
      await tx.testHistory.create({
        data: {
          ioId,
          result: TEST_CONSTANTS.RESULT_CLEARED,
          timestamp,
          comments: historyComment,
          state: plcState,
          testedBy: currentUser
        }
      })

      // Clear the IO
      await tx.io.update({
        where: { id: ioId },
        data: {
          result: null,
          timestamp: null,
          comments: null,
          version: { increment: 1 }
        }
      })
    })

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
    const io = await prisma.io.findUnique({
      where: { id: ioId }
    })

    if (!io) {
      return { success: false, changesWereMade: false, errorMessage: 'IO not found' }
    }

    const oldComment = io.comments ?? ''
    const normalizedNew = newComment ?? ''

    // No change needed
    if (oldComment === normalizedNew) {
      return { success: true, changesWereMade: false }
    }

    const plcState = getPlcStateForIo(ioId)
    const timestamp = createTimestamp()
    const { historyResult, historyComment } = determineCommentChange(oldComment, normalizedNew)

    // Use transaction for atomicity
    await prisma.$transaction(async (tx) => {
      // Update the IO
      await tx.io.update({
        where: { id: ioId },
        data: {
          comments: normalizedNew,
          timestamp,
          version: { increment: 1 }
        }
      })

      // Create history record
      await tx.testHistory.create({
        data: {
          ioId,
          result: historyResult,
          timestamp,
          comments: historyComment,
          state: plcState,
          testedBy: currentUser
        }
      })
    })

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
export async function getIoByIdAsync(ioId: number): Promise<IoWithState | null> {
  const io = await prisma.io.findUnique({
    where: { id: ioId }
  })

  if (!io) return null

  return {
    ...io,
    state: getPlcStateForIo(io.id)
  }
}

/**
 * Get all IOs for a subsystem with current PLC states
 */
export async function getIosBySubsystemAsync(subsystemId: number): Promise<IoWithState[]> {
  const ios = await prisma.io.findMany({
    where: { subsystemId },
    orderBy: { order: 'asc' }
  })

  const { tags } = getPlcTags()
  const stateMap = new Map(tags.map(t => [t.id, t.state]))

  return ios.map(io => ({
    ...io,
    state: stateMap.get(io.id)
  }))
}

/**
 * Get test statistics for a subsystem
 */
export async function getTestStatsAsync(subsystemId?: number): Promise<{
  total: number
  passed: number
  failed: number
  untested: number
}> {
  const where = subsystemId ? { subsystemId } : {}

  const [total, passed, failed] = await Promise.all([
    prisma.io.count({ where }),
    prisma.io.count({ where: { ...where, result: TEST_CONSTANTS.RESULT_PASSED } }),
    prisma.io.count({ where: { ...where, result: TEST_CONSTANTS.RESULT_FAILED } })
  ])

  return {
    total,
    passed,
    failed,
    untested: total - passed - failed
  }
}

/**
 * Get test history for an IO
 */
export async function getTestHistoryAsync(ioId: number, limit: number = 100) {
  return prisma.testHistory.findMany({
    where: { ioId },
    orderBy: { timestamp: 'desc' },
    take: limit
  })
}

// Private helper functions

async function updateTestResultAsync(
  ioId: number,
  result: string,
  options: TestResultRequest = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    const io = await prisma.io.findUnique({
      where: { id: ioId }
    })

    if (!io) {
      return { success: false, error: 'IO not found' }
    }

    const sanitizedComments = sanitizeComment(options.comments) ?? null
    const plcState = getPlcStateForIo(ioId)
    const timestamp = createTimestamp()

    // Use transaction for atomicity
    await prisma.$transaction(async (tx) => {
      // Update the IO
      await tx.io.update({
        where: { id: ioId },
        data: {
          result,
          timestamp,
          comments: sanitizedComments,
          version: { increment: 1 }
        }
      })

      await tx.testHistory.create({
        data: {
          ioId,
          result,
          timestamp,
          comments: io.comments,
          state: plcState,
          testedBy: options.currentUser ?? 'Unknown',
          failureMode: options.failureMode || null,
        }
      })
    })

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
