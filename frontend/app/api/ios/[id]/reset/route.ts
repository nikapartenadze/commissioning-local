import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { createTimestamp, TEST_CONSTANTS } from '@/lib/services/io-test-service'

/**
 * POST /api/ios/:id/reset
 */
export async function POST(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string)

    if (isNaN(ioId)) {
      return res.status(400).json({ error: 'Invalid IO ID' })
    }

    let currentUser = 'Unknown'
    try {
      if (req.body && req.body.currentUser) {
        currentUser = req.body.currentUser
      }
    } catch {
      // Empty body is OK
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return res.status(404).json({ error: 'IO not found' })
    }

    const hadComments = !!io.Comments
    const hadResult = !!io.Result

    if (!hadComments && !hadResult) {
      return res.json({
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

    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)
    const plcState = tag?.state

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

    try {
      db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        TEST_CONSTANTS.RESULT_CLEARED,
        historyComment || null,
        plcState ?? null,
        new Date().toISOString(),
        newVersion - 1
      )

      try {
        const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
        getCloudSseClient()?.trackPushedId(ioId)
      } catch {}

      const key = `io:${ioId}`
      enqueueSyncPush(key, async () => {
        // Read the LATEST local state at push time — this is what makes rapid edits safe
        const latest = db.prepare('SELECT Result, Comments, Version FROM Ios WHERE id = ?').get(ioId) as
          | { Result: string | null; Comments: string | null; Version: number | null }
          | undefined
        if (!latest) return

        // Pull the freshest PLC state for this IO if available
        let latestState: string | null = null
        try {
          const { tags: latestTags } = getPlcTags()
          const latestTag = latestTags.find(t => t.id === ioId)
          latestState = latestTag?.state ?? null
        } catch {}

        // Find the latest pending row + its inspector for this IO so we can push the right testedBy
        const pending = db.prepare(
          'SELECT id, InspectorName FROM PendingSyncs WHERE IoId = ? ORDER BY id DESC LIMIT 1'
        ).get(ioId) as { id: number; InspectorName: string | null } | undefined

        const latestVersion = latest.Version ?? 0

        try {
          const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
          const syncService = getCloudSyncService()
          console.log(`[Reset] Attempting instant sync for IO ${ioId}`)
          const synced = await syncService.syncIoUpdate({
            id: ioId,
            result: latest.Result,
            comments: latest.Comments,
            testedBy: pending?.InspectorName || currentUser || null,
            state: latestState,
            version: latestVersion - 1,
            timestamp: new Date().toISOString(),
          })
          if (synced) {
            // Cloud accepted our update — drop the latest pendingSync row for this IO
            try {
              const latestPending = db.prepare(
                'SELECT id FROM PendingSyncs WHERE IoId = ? ORDER BY id DESC LIMIT 1'
              ).get(ioId) as { id: number } | undefined
              if (latestPending) db.prepare('DELETE FROM PendingSyncs WHERE id = ?').run(latestPending.id)
            } catch {}
            console.log(`[Reset] Instant sync succeeded for IO ${ioId}`)
          } else {
            console.log(`[Reset] Instant sync returned false for IO ${ioId} — queued for retry`)
          }
        } catch (syncErr) {
          console.warn(`[Reset] Instant sync error for IO ${ioId}:`, syncErr instanceof Error ? syncErr.message : syncErr)
        }
      })
    } catch (syncError) {
      console.error('[Reset] Failed to create PendingSync:', syncError)
    }

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

    return res.json({
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
    return res.status(500).json({ error: 'Failed to reset IO' })
  }
}
