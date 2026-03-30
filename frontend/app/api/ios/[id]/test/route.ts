export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getPlcTags, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import {
  sanitizeComment,
  createTimestamp,
  TEST_CONSTANTS
} from '@/lib/services/io-test-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/ios/[id]/test
 * Record a test result for an IO
 *
 * Request body:
 * {
 *   result: 'Pass' | 'Fail',
 *   comments?: string,
 *   currentUser?: string,
 *   failureMode?: string
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { id } = await params
    const ioId = parseInt(id)

    if (isNaN(ioId)) {
      return NextResponse.json({ error: 'Invalid IO ID' }, { status: 400 })
    }

    const body = await request.json()
    const { result, comments, currentUser, failureMode } = body

    // Validate result
    if (!result || !['Pass', 'Fail', 'Passed', 'Failed'].includes(result)) {
      return NextResponse.json(
        { error: 'Invalid result. Must be "Pass" or "Fail"' },
        { status: 400 }
      )
    }

    const normalizedResult = result === 'Pass' || result === 'Passed'
      ? TEST_CONSTANTS.RESULT_PASSED
      : TEST_CONSTANTS.RESULT_FAILED

    // Validate comment length
    if (comments && comments.length > 500) {
      return NextResponse.json(
        { error: 'Comment must be 500 characters or fewer' },
        { status: 400 }
      )
    }

    const io = await prisma.io.findUnique({
      where: { id: ioId }
    })

    if (!io) {
      return NextResponse.json({ error: 'IO not found' }, { status: 404 })
    }

    // Get current PLC state
    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)
    const plcState = tag?.state

    const sanitizedComments = sanitizeComment(comments)
    const timestamp = createTimestamp()

    // Combine failure mode + comment for the IO record (syncs to cloud)
    // "Other" means user typed the reason themselves — don't prepend "Other"
    let combinedComment = ''
    if (failureMode && failureMode !== 'Other') {
      combinedComment = sanitizedComments ? `${failureMode} — ${sanitizedComments}` : failureMode
    } else {
      combinedComment = sanitizedComments || ''
    }

    // Store old comment for history before updating
    const oldComment = io.comments

    // Update IO and create history in transaction
    const [updatedIo, testHistory] = await prisma.$transaction([
      prisma.io.update({
        where: { id: ioId },
        data: {
          result: normalizedResult,
          timestamp,
          comments: combinedComment || null,
          version: { increment: 1 }
        }
      }),
      prisma.testHistory.create({
        data: {
          ioId,
          result: normalizedResult,
          timestamp,
          comments: oldComment,
          state: plcState,
          testedBy: currentUser ?? 'Unknown',
          failureMode: failureMode || null,
        }
      })
    ])

    // Create PendingSync entry as fallback, then attempt immediate cloud sync
    try {
      const pendingSync = await prisma.pendingSync.create({
        data: {
          ioId,
          inspectorName: currentUser || null,
          testResult: normalizedResult,
          comments: combinedComment || null,
          state: plcState || null,
          timestamp: new Date(),
          version: updatedIo.version - BigInt(1), // Pre-increment version to match cloud
        },
      })

      // Track this IO so SSE doesn't echo it back
      try {
        const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
        getCloudSseClient()?.trackPushedId(ioId)
      } catch {}

      // Attempt immediate sync — if it succeeds, remove from queue
      try {
        const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
        const syncService = getCloudSyncService()
        const synced = await syncService.syncIoUpdate({
          id: ioId,
          result: normalizedResult,
          comments: combinedComment || null,
          testedBy: currentUser || null,
          state: plcState || null,
          version: Number(updatedIo.version) - 1, // Send pre-increment version to match cloud
          timestamp: new Date().toISOString(),
        })
        if (synced) {
          await prisma.pendingSync.delete({ where: { id: pendingSync.id } }).catch(() => {})
        }
      } catch {
        // Immediate sync failed — PendingSync stays in queue for auto-sync retry
      }
    } catch (syncError) {
      console.error('[Test] Failed to create PendingSync:', syncError)
    }

    // Broadcast to all connected browsers via WebSocket
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'UpdateIO',
          id: ioId,
          result: normalizedResult,
          state: plcState ?? '',
          timestamp,
          comments: combinedComment || '',
        }),
      })
    } catch {
      // WebSocket broadcast is best-effort
    }

    console.log(`Test recorded for IO ${ioId}: ${normalizedResult} by ${currentUser ?? 'Unknown'}`)

    return NextResponse.json({
      success: true,
      message: `IO marked as ${normalizedResult.toLowerCase()}`,
      io: {
        id: updatedIo.id,
        subsystemId: updatedIo.subsystemId,
        name: updatedIo.name,
        description: updatedIo.description,
        result: updatedIo.result,
        timestamp: updatedIo.timestamp,
        comments: updatedIo.comments,
        order: updatedIo.order,
        version: updatedIo.version.toString(),
        state: plcState ?? null
      },
      testHistory: {
        id: testHistory.id,
        ioId: testHistory.ioId,
        result: testHistory.result,
        timestamp: testHistory.timestamp,
        testedBy: testHistory.testedBy
      }
    })
  } catch (error) {
    console.error('Error recording test result:', error)
    return NextResponse.json(
      { error: 'Failed to record test result' },
      { status: 500 }
    )
  }
}
