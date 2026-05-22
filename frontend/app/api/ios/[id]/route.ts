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

    // Reject any explicit `result` value that isn't a recognized op — closes
    // the second-line vector where a misbehaving older client could POST
    // {result: null, comments: "..."} and silently wipe ios.Result before
    // the sync classifier below ever runs. Undefined means "no result change"
    // and is allowed (comment-only update).
    if (result !== undefined && !['Passed', 'Failed', 'Cleared'].includes(result)) {
      console.warn(
        `[IO Update] REJECTED-PAYLOAD ioId=${ioId} tester=${currentUser ?? 'unknown'} ` +
        `result=${JSON.stringify(result)} — must be Passed | Failed | Cleared | undefined.`,
      )
      return res.status(400).json({
        error: 'Invalid result value. Must be "Passed", "Failed", "Cleared", or omitted for comment-only updates.',
      })
    }

    if (comments && comments.length > 500) {
      return res.status(400).json({ error: 'Comment must be 500 characters or fewer' })
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return res.status(404).json({ error: 'IO not found' })
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

    // Determine sync intent.
    //
    // Historical bug (2026-05-21 incident): we used to write
    //   TestResult = updatedIo.Result || null
    // which sent `result: null` to /api/sync/update whenever someone added a
    // comment to an IO that hadn't been pass/failed yet. The cloud handler
    // didn't recognize null as a comment op, so it interpreted the push as a
    // "set result to null" instruction, bumped ios.version, and wrote a
    // testhistories row with result=null. Once cloud.version had moved on, the
    // electrician's later real Pass push always lost the version race
    // (updatedCount=0) and was eventually dropped from PendingSyncs after the
    // retry cap, silently losing the test.
    //
    // Fix: a PendingSync row must always carry an explicit operation string
    // the cloud handler understands ('Passed' / 'Failed' / 'Cleared' / one of
    // the 'Comment …' ops). If we can't classify the change, we skip the
    // sync — local state is the source of truth and the next real test will
    // sync correctly.
    const commentsChanged = (sanitizedComments ?? '') !== (io.Comments ?? '')
    const resultChanged = result !== undefined && result !== io.Result

    let syncIntent: string | null = null
    if (resultChanged) {
      // Real test result push (Pass / Fail / Cleared).
      syncIntent = updatedIo.Result || null
    } else if (commentsChanged) {
      // Comment-only update — map to one of the cloud's comment ops.
      const oldHadComment = !!(io.Comments && io.Comments.length > 0)
      const newHasComment = !!(sanitizedComments && sanitizedComments.length > 0)
      if (!oldHadComment && newHasComment) syncIntent = 'Comment Added'
      else if (oldHadComment && !newHasComment) syncIntent = 'Comment Removed'
      else if (oldHadComment && newHasComment) syncIntent = 'Comment Modified'
    }

    if (!syncIntent) {
      console.log(
        `[IO Update] No syncable change for IO ${ioId} ` +
        `(resultChanged=${resultChanged}, commentsChanged=${commentsChanged}) — ` +
        `skipping PendingSync to avoid sending result=null to cloud.`
      )
    } else {
      let pendingId: number | bigint | undefined
      try {
        const info = db.prepare(
          'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          ioId,
          currentUser || null,
          syncIntent,
          (sanitizedComments !== undefined ? sanitizedComments : io.Comments) || null,
          plcState ?? null,
          new Date().toISOString(),
          newVersion - 1
        )
        pendingId = info.lastInsertRowid

        console.log(
          `[IO Update] PENDING-QUEUED pendingId=${pendingId} ioId=${ioId} ` +
          `result=${syncIntent} tester=${currentUser ?? 'unknown'} version=${newVersion - 1}`,
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
        // CRITICAL: the SQLite write to Ios already succeeded by this point
        // (txn at line 91-100), but the PendingSync row didn't make it onto
        // the queue. Without a loud log this would be the new silent-loss
        // vector. Include enough context that an oncall person can recover
        // the row by hand if needed.
        console.error(
          `[IO Update] PENDING-QUEUE-FAIL ioId=${ioId} ` +
          `result=${syncIntent} tester=${currentUser ?? 'unknown'} version=${newVersion - 1} ` +
          `err=${syncError instanceof Error ? syncError.message : String(syncError)}`,
        )
      }
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
