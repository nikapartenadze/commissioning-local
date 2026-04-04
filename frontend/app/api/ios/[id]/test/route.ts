export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
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

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return NextResponse.json({ error: 'IO not found' }, { status: 404 })
    }

    // Block SPARE IOs from being tested
    if (io.Description?.toUpperCase().includes('SPARE')) {
      return NextResponse.json({ error: 'SPARE IOs cannot be tested' }, { status: 400 })
    }

    // Block testing if parent device is faulted (ConnectionFaulted = true)
    {
      const { extractDeviceName } = await import('@/lib/db-sqlite')
      const deviceName = io.NetworkDeviceName || extractDeviceName(io.Name || '')
      if (deviceName) {
        const client = getPlcTags()
        const faultTag = `${deviceName}:I.ConnectionFaulted`
        const faultState = client.tags.find(t => t.name === faultTag)
        if (faultState && faultState.state === 'TRUE') {
          return NextResponse.json(
            { error: `Cannot test — parent device ${deviceName} has a connection fault. Fix the fault first.` },
            { status: 400 }
          )
        }
      }
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
    const oldComment = io.Comments
    const newVersion = (io.Version ?? 0) + 1

    // Update IO and create history in transaction
    let testHistoryId: number | bigint = 0
    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ?, Version = ? WHERE id = ?'
      ).run(normalizedResult, timestamp, combinedComment || null, newVersion, ioId)

      const histResult = db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy, FailureMode) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, normalizedResult, timestamp, oldComment, plcState ?? null, currentUser ?? 'Unknown', failureMode || null)
      testHistoryId = histResult.lastInsertRowid
    })
    txn()

    const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    // Create PendingSync entry as fallback, then attempt immediate cloud sync
    try {
      const syncResult = db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        normalizedResult,
        combinedComment || null,
        plcState ?? null,
        new Date().toISOString(),
        newVersion - 1 // Pre-increment version to match cloud
      )
      const pendingSyncId = syncResult.lastInsertRowid

      // Track this IO so SSE doesn't echo it back
      try {
        const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
        getCloudSseClient()?.trackPushedId(ioId)
      } catch {}

      // Attempt immediate sync — if it succeeds, remove from queue
      try {
        const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
        const syncService = getCloudSyncService()
        console.log(`[Test] Attempting instant sync for IO ${ioId}`)
        const synced = await syncService.syncIoUpdate({
          id: ioId,
          result: normalizedResult,
          comments: combinedComment || null,
          testedBy: currentUser || null,
          state: plcState ?? null,
          version: newVersion - 1,
          timestamp: new Date().toISOString(),
        })
        if (synced) {
          try { db.prepare('DELETE FROM PendingSyncs WHERE id = ?').run(Number(pendingSyncId)) } catch {}
          console.log(`[Test] Instant sync succeeded for IO ${ioId}`)
        } else {
          console.log(`[Test] Instant sync returned false for IO ${ioId} — queued for retry`)
        }
      } catch (syncErr) {
        console.warn(`[Test] Instant sync error for IO ${ioId}:`, syncErr instanceof Error ? syncErr.message : syncErr)
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
        subsystemId: updatedIo.SubsystemId,
        name: updatedIo.Name,
        description: updatedIo.Description,
        result: updatedIo.Result,
        timestamp: updatedIo.Timestamp,
        comments: updatedIo.Comments,
        order: updatedIo.Order,
        version: (updatedIo.Version ?? 0).toString(),
        state: plcState ?? null
      },
      testHistory: {
        id: Number(testHistoryId),
        ioId,
        result: normalizedResult,
        timestamp,
        testedBy: currentUser ?? 'Unknown'
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
