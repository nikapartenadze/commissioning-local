export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { sanitizeComment, createTimestamp } from '@/lib/services/io-test-service'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * GET /api/ios/[id]
 * Get single IO by ID with current PLC state
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { id } = await params
    const ioId = parseInt(id)

    if (isNaN(ioId)) {
      return NextResponse.json({ error: 'Invalid IO ID' }, { status: 400 })
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return NextResponse.json({ error: 'IO not found' }, { status: 404 })
    }

    // Get current PLC state
    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)

    const ioWithState = {
      id: io.id,
      subsystemId: io.SubsystemId,
      name: io.Name,
      description: io.Description,
      result: io.Result,
      timestamp: io.Timestamp,
      comments: io.Comments,
      order: io.Order,
      version: (io.Version ?? 0).toString(),
      state: tag?.state ?? null,
      networkDeviceName: io.NetworkDeviceName ?? null,
      isOutput: io.Name?.includes(':O.') || io.Name?.includes(':SO.') || io.Name?.includes('.O.') || io.Name?.includes(':O:') || io.Name?.includes('.Outputs.') || io.Name?.endsWith('.DO') || io.Name?.endsWith('_DO'),
      hasResult: !!io.Result,
      isPassed: io.Result === 'Passed',
      isFailed: io.Result === 'Failed'
    }

    return NextResponse.json(ioWithState)
  } catch (error) {
    console.error('Error fetching IO:', error)
    return NextResponse.json(
      { error: 'Failed to fetch IO' },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/ios/[id]
 * Update IO result and/or comments
 */
export async function PUT(
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
    const { result, comments, currentUser } = body

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

    // Get current PLC state
    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)
    const plcState = tag?.state

    const sanitizedComments = sanitizeComment(comments)
    const timestamp = createTimestamp()

    // Update IO and create history in transaction
    const newVersion = (io.Version ?? 0) + 1
    const updatedResult = result !== undefined ? result : io.Result
    const updatedComments = sanitizedComments !== undefined ? sanitizedComments : io.Comments

    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Result = ?, Comments = ?, Timestamp = ?, Version = ? WHERE id = ?'
      ).run(updatedResult, updatedComments, timestamp, newVersion, ioId)

      db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(ioId, result ?? io.Result ?? 'Updated', timestamp, io.Comments, plcState ?? null, currentUser ?? 'Unknown')
    })
    txn()

    const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    // Queue for cloud sync + attempt immediate sync
    try {
      const syncResult = db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        updatedIo.Result || null,
        (sanitizedComments !== undefined ? sanitizedComments : io.Comments) || null,
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

      try {
        const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
        const syncService = getCloudSyncService()
        const synced = await syncService.syncIoUpdate({
          id: ioId,
          result: updatedIo.Result || null,
          comments: (sanitizedComments !== undefined ? sanitizedComments : io.Comments) || null,
          testedBy: currentUser || null,
          state: plcState ?? null,
          version: newVersion - 1, // Send pre-increment version to match cloud
          timestamp: new Date().toISOString(),
        })
        if (synced) {
          try { db.prepare('DELETE FROM PendingSyncs WHERE id = ?').run(Number(pendingSyncId)) } catch {}
        }
      } catch {
        // Immediate sync failed — PendingSync stays in queue
      }
    } catch (syncError) {
      console.error('[IO Update] Failed to create PendingSync:', syncError)
    }

    // Broadcast to all connected browsers via WebSocket
    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'UpdateIO',
          id: ioId,
          result: updatedIo.Result ?? 'Not Tested',
          state: plcState ?? '',
          timestamp: updatedIo.Timestamp ?? '',
          comments: updatedIo.Comments ?? '',
        }),
      })
    } catch {
      // WebSocket broadcast is best-effort
    }

    return NextResponse.json({
      success: true,
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
      }
    })
  } catch (error) {
    console.error('Error updating IO:', error)
    return NextResponse.json(
      { error: 'Failed to update IO' },
      { status: 500 }
    )
  }
}
