import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { drainPendingSyncsForIo } from '@/lib/cloud/pending-sync-utils'
import { createTimestamp, TEST_CONSTANTS } from '@/lib/services/io-test-service'

/**
 * POST /api/guided/clear
 *
 * Guided-mode counterpart to POST /api/ios/:id/reset. Does the same DB
 * work — wipes Result/Comments/Timestamp, bumps Version, writes a
 * Cleared TestHistory row, enqueues a PendingSync — but is NOT gated by
 * noTestingOnServerLaptop so demo/training flows can clear IOs from the
 * same machine that's running the local server (Vite proxy makes the
 * proxied call look like loopback to Express).
 *
 * Body: { ioId, currentUser? }
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = req.body ?? {}
    const ioId = parseInt(String(body.ioId), 10)
    if (!Number.isFinite(ioId) || ioId <= 0) {
      return res.status(400).json({ error: 'Invalid ioId' })
    }
    const currentUser = (body.currentUser as string | undefined) ?? 'Unknown'

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined
    if (!io) return res.status(404).json({ error: 'IO not found' })

    const hadComments = !!io.Comments
    const hadResult = !!io.Result
    if (!hadComments && !hadResult) {
      return res.json({ success: true, alreadyCleared: true })
    }

    let plcState: string | null = null
    try {
      const { tags } = getPlcTags()
      plcState = tags.find(t => t.id === ioId)?.state ?? null
    } catch { /* PLC not connected — leave null */ }

    let historyComment: string | null = null
    if (hadResult && hadComments) historyComment = io.Comments
    else if (hadResult) historyComment = `Cleared ${io.Result} result`
    else historyComment = 'Cleared comments'

    const timestamp = createTimestamp()
    const newVersion = (io.Version ?? 0) + 1
    let testHistoryId: number | bigint = 0

    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Result = NULL, Timestamp = NULL, Comments = NULL, Version = ? WHERE id = ?'
      ).run(newVersion, ioId)
      const histResult = db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy, FailureMode, Source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, TEST_CONSTANTS.RESULT_CLEARED, timestamp, historyComment, plcState, currentUser, null, 'guided')
      testHistoryId = histResult.lastInsertRowid
    })
    txn()

    try {
      const info = db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, currentUser || null, TEST_CONSTANTS.RESULT_CLEARED, historyComment, plcState, new Date().toISOString(), newVersion - 1)
      console.log(
        `[Guided clear] PENDING-QUEUED pendingId=${info.lastInsertRowid} ioId=${ioId} ` +
        `result=${TEST_CONSTANTS.RESULT_CLEARED} tester=${currentUser ?? 'unknown'} version=${newVersion - 1}`,
      )

      try {
        const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
        getCloudSseClient()?.trackPushedId(ioId)
      } catch { /* SSE optional */ }

      const key = `io:${ioId}`
      enqueueSyncPush(key, async () => {
        try { await drainPendingSyncsForIo(ioId, 'Guided-Clear', currentUser) }
        catch (syncErr) { console.warn('[Guided clear] sync error for', ioId, ':', syncErr instanceof Error ? syncErr.message : syncErr) }
      })
    } catch (syncError) {
      console.error(
        `[Guided clear] PENDING-QUEUE-FAIL ioId=${ioId} ` +
        `result=${TEST_CONSTANTS.RESULT_CLEARED} tester=${currentUser ?? 'unknown'} version=${newVersion - 1} ` +
        `err=${syncError instanceof Error ? syncError.message : String(syncError)}`,
      )
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
          timestamp,
          comments: '',
          // Guided Clear blanks Ios.FailureMode server-side; mirror on the
          // WS event.
          failureMode: null,
        }),
      })
    } catch { /* WS broadcast best-effort */ }

    return res.json({
      success: true,
      io: { id: ioId, version: newVersion.toString() },
      testHistoryId: Number(testHistoryId),
    })
  } catch (error) {
    console.error('[Guided clear] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
  }
}
