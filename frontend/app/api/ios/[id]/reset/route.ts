export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { createTimestamp, TEST_CONSTANTS } from '@/lib/services/io-test-service'
import { requireAuth } from '@/lib/auth/middleware'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/ios/[id]/reset
 * Reset/clear IO test result to null
 *
 * Request body (optional):
 * {
 *   currentUser?: string
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams
) {
  const authError = requireAuth(request)
  if (authError) return authError

  try {
    const { id } = await params
    const ioId = parseInt(id)

    if (isNaN(ioId)) {
      return NextResponse.json({ error: 'Invalid IO ID' }, { status: 400 })
    }

    let currentUser = 'Unknown'
    try {
      const body = await request.json()
      if (body.currentUser) {
        currentUser = body.currentUser
      }
    } catch {
      // Empty body is OK
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return NextResponse.json({ error: 'IO not found' }, { status: 404 })
    }

    // Check if already cleared
    const hadComments = !!io.Comments
    const hadResult = !!io.Result

    if (!hadComments && !hadResult) {
      // Already cleared, nothing to do
      return NextResponse.json({
        success: true,
        message: 'IO already cleared',
        io: {
          id: io.id,
          subsystemId: io.SubsystemId,
          name: io.Name,
          description: io.Description,
          result: io.Result,
          timestamp: io.Timestamp,
          comments: io.Comments,
          order: io.Order,
          version: (io.Version ?? 0).toString(),
          state: null
        }
      })
    }

    // Get current PLC state
    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)
    const plcState = tag?.state

    // Build history comment
    let historyComment: string | null = null
    if (hadResult && hadComments) {
      historyComment = io.Comments
    } else if (hadResult) {
      historyComment = `Cleared ${io.Result} result`
    } else {
      historyComment = 'Cleared comments'
    }

    const timestamp = createTimestamp()
    const newVersion = (io.Version ?? 0) + 1

    // Clear IO and create history in transaction
    let testHistoryId: number | bigint = 0
    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Result = NULL, Timestamp = NULL, Comments = NULL, Version = ? WHERE id = ?'
      ).run(newVersion, ioId)

      const histResult = db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(ioId, TEST_CONSTANTS.RESULT_CLEARED, timestamp, historyComment, plcState ?? null, currentUser)
      testHistoryId = histResult.lastInsertRowid
    })
    txn()

    // Create PendingSync entry as fallback, then attempt immediate cloud sync
    try {
      const syncResult = db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        TEST_CONSTANTS.RESULT_CLEARED,
        historyComment || null,
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

      // Attempt immediate sync
      try {
        const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
        const syncService = getCloudSyncService()
        console.log(`[Reset] Attempting instant sync for IO ${ioId}`)
        const synced = await syncService.syncIoUpdate({
          id: ioId,
          result: TEST_CONSTANTS.RESULT_CLEARED,
          comments: historyComment || null,
          testedBy: currentUser || null,
          state: plcState ?? null,
          version: newVersion - 1,
          timestamp: new Date().toISOString(),
        })
        if (synced) {
          try { db.prepare('DELETE FROM PendingSyncs WHERE id = ?').run(Number(pendingSyncId)) } catch {}
          console.log(`[Reset] Instant sync succeeded for IO ${ioId}`)
        } else {
          console.log(`[Reset] Instant sync returned false for IO ${ioId} — queued for retry`)
        }
      } catch (syncErr) {
        console.warn(`[Reset] Instant sync error for IO ${ioId}:`, syncErr instanceof Error ? syncErr.message : syncErr)
      }
    } catch (syncError) {
      console.error('[Reset] Failed to create PendingSync:', syncError)
    }

    // Broadcast to all connected browsers via WebSocket
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'UpdateIO',
          id: ioId,
          result: 'Not Tested',
          state: plcState ?? '',
          timestamp: timestamp,
          comments: '',
        }),
      })
    } catch {
      // WebSocket broadcast is best-effort
    }

    console.log(`Test result cleared for IO ${ioId} by ${currentUser}`)

    return NextResponse.json({
      success: true,
      message: 'IO result cleared',
      io: {
        id: io.id,
        subsystemId: io.SubsystemId,
        name: io.Name,
        description: io.Description,
        result: null,
        timestamp: null,
        comments: null,
        order: io.Order,
        version: newVersion.toString(),
        state: plcState ?? null
      },
      testHistory: {
        id: Number(testHistoryId),
        ioId,
        result: TEST_CONSTANTS.RESULT_CLEARED,
        timestamp,
        testedBy: currentUser
      }
    })
  } catch (error) {
    console.error('Error resetting IO:', error)
    return NextResponse.json(
      { error: 'Failed to reset IO' },
      { status: 500 }
    )
  }
}
