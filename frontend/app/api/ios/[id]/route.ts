import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { drainPendingSyncsForIo } from '@/lib/cloud/pending-sync-utils'
import { sanitizeComment, createTimestamp } from '@/lib/services/io-test-service'

/**
 * GET /api/ios/:id
 */
export async function GET(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string)

    if (isNaN(ioId)) {
      return res.status(400).json({ error: 'Invalid IO ID' })
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return res.status(404).json({ error: 'IO not found' })
    }

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

    return res.json(ioWithState)
  } catch (error) {
    console.error('Error fetching IO:', error)
    return res.status(500).json({ error: 'Failed to fetch IO' })
  }
}

/**
 * PUT /api/ios/:id
 */
export async function PUT(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string)

    if (isNaN(ioId)) {
      return res.status(400).json({ error: 'Invalid IO ID' })
    }

    const body = req.body
    const { result, comments, currentUser } = body

    if (comments && comments.length > 500) {
      return res.status(400).json({ error: 'Comment must be 500 characters or fewer' })
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return res.status(404).json({ error: 'IO not found' })
    }

    if (false && io.InstallationStatus && io.InstallationStatus !== 'complete') {
      return res.status(422).json({
        error: 'Cannot test: device is not fully installed',
        installationStatus: io.InstallationStatus,
        installationPercent: io.InstallationPercent
      })
    }

    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)
    const plcState = tag?.state

    const sanitizedComments = sanitizeComment(comments)
    const timestamp = createTimestamp()

    const newVersion = (io.Version ?? 0) + 1
    const updatedResult = result !== undefined ? result : io.Result
    const updatedComments = sanitizedComments !== undefined ? sanitizedComments : io.Comments
    // Preserve original test timestamp on comment-only updates
    const updatedTimestamp = result !== undefined ? timestamp : (io.Timestamp || timestamp)

    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Result = ?, Comments = ?, Timestamp = ?, Version = ? WHERE id = ?'
      ).run(updatedResult, updatedComments, updatedTimestamp, newVersion, ioId)

      db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy, FailureMode, Source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, result ?? io.Result ?? 'Updated', timestamp, updatedComments, plcState ?? null, currentUser ?? 'Unknown', null, 'local')
    })
    txn()

    const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    try {
      db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        updatedIo.Result || null,
        (sanitizedComments !== undefined ? sanitizedComments : io.Comments) || null,
        plcState ?? null,
        new Date().toISOString(),
        newVersion - 1
      )

      try {
        const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
        getCloudSseClient()?.trackPushedId(ioId)
      } catch (e) { console.warn('[IO Update SSE] trackPushedId failed:', e) }

      const key = `io:${ioId}`
      enqueueSyncPush(key, async () => {
        try {
          await drainPendingSyncsForIo(ioId, 'IO Update', currentUser)
        } catch (syncErr) {
          console.warn(`[IO Update] Instant sync error for IO ${ioId}:`, syncErr instanceof Error ? syncErr.message : syncErr)
        }
      })
    } catch (syncError) {
      console.error('[IO Update] Failed to create PendingSync:', syncError)
    }

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

    return res.json({
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
    return res.status(500).json({ error: 'Failed to update IO' })
  }
}
