import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { drainPendingSyncsForIo } from '@/lib/cloud/pending-sync-utils'
import { sanitizeComment, createTimestamp, TEST_CONSTANTS } from '@/lib/services/io-test-service'

/**
 * POST /api/guided/test
 *
 * Guided-mode test recorder. Mirrors POST /api/ios/:id/test but skips the
 * PLC-required checks (no PLC connection requirement, no connection-fault
 * gate) so the operator can walk a subsystem on a tablet that isn't
 * wired to the live PLC — useful for demo / training / cross-site test.
 *
 * Still:
 *   - rejects SPARE-IO passes (data integrity)
 *   - updates Ios + creates a TestHistory row + enqueues a PendingSync
 *   - broadcasts the result over the WS so the main grid (in another tab)
 *     reflects it live
 *
 * Body: { ioId, result, comments?, currentUser?, failureMode? }
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = req.body ?? {}
    const ioId = parseInt(String(body.ioId), 10)
    if (!Number.isFinite(ioId) || ioId <= 0) {
      return res.status(400).json({ error: 'Invalid ioId' })
    }

    const { result, comments, currentUser, failureMode } = body
    if (!result || !['Pass', 'Fail', 'Passed', 'Failed'].includes(result)) {
      return res.status(400).json({ error: 'Invalid result. Must be "Pass" or "Fail"' })
    }
    const normalizedResult = result === 'Pass' || result === 'Passed'
      ? TEST_CONSTANTS.RESULT_PASSED
      : TEST_CONSTANTS.RESULT_FAILED

    if (typeof comments === 'string' && comments.length > 500) {
      return res.status(400).json({ error: 'Comment must be 500 characters or fewer' })
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined
    if (!io) return res.status(404).json({ error: 'IO not found' })

    if (io.Description?.toUpperCase().includes('SPARE') && normalizedResult === TEST_CONSTANTS.RESULT_PASSED) {
      return res.status(400).json({ error: 'SPARE IOs cannot be passed' })
    }

    // Install-tracker status is informational only — techs often test devices
    // before the tracker is updated, so Pass is no longer gated on it.

    // Best-effort PLC state for the history row — null if PLC isn't connected.
    let plcState: string | null = null
    try {
      const { tags } = getPlcTags()
      plcState = tags.find(t => t.id === ioId)?.state ?? null
    } catch { /* PLC not available — leave null */ }

    const sanitizedComments = sanitizeComment(comments)
    const timestamp = createTimestamp()

    let combinedComment = ''
    if (failureMode && failureMode !== 'Other') {
      combinedComment = sanitizedComments ? `${failureMode} — ${sanitizedComments}` : failureMode
    } else {
      combinedComment = sanitizedComments || ''
    }

    const oldComment = io.Comments
    const newVersion = (io.Version ?? 0) + 1
    let testHistoryId: number | bigint = 0

    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ?, Version = ? WHERE id = ?'
      ).run(normalizedResult, timestamp, combinedComment || null, newVersion, ioId)
      const histResult = db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy, FailureMode, Source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, normalizedResult, timestamp, oldComment, plcState, currentUser ?? 'Unknown', failureMode || null, 'guided')
      testHistoryId = histResult.lastInsertRowid
    })
    txn()

    const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    // Cloud sync — best-effort, never block the response
    try {
      db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, currentUser || null, normalizedResult, combinedComment || null, plcState, new Date().toISOString(), newVersion - 1)

      try {
        const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
        getCloudSseClient()?.trackPushedId(ioId)
      } catch { /* SSE optional */ }

      const key = `io:${ioId}`
      enqueueSyncPush(key, async () => {
        try { await drainPendingSyncsForIo(ioId, 'Guided', currentUser) }
        catch (syncErr) { console.warn('[Guided test] sync error for', ioId, ':', syncErr instanceof Error ? syncErr.message : syncErr) }
      })
    } catch (syncError) {
      console.error('[Guided test] Failed to enqueue sync:', syncError)
    }

    // WS broadcast — best-effort
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
    } catch { /* WS broadcast is best-effort */ }

    return res.json({
      success: true,
      io: {
        id: updatedIo.id,
        result: updatedIo.Result,
        timestamp: updatedIo.Timestamp,
        comments: updatedIo.Comments,
        version: (updatedIo.Version ?? 0).toString(),
        state: plcState,
      },
      testHistoryId: Number(testHistoryId),
    })
  } catch (error) {
    console.error('[Guided test] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
  }
}
