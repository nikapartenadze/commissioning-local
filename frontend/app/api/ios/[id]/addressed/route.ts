import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { getMcmIdForIo } from '@/lib/mcm-registry'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { drainPendingSyncsForIo } from '@/lib/cloud/pending-sync-utils'
import {
  sanitizeComment,
  createTimestamp,
  TEST_CONSTANTS,
  getPlcStateForIo,
} from '@/lib/services/io-test-service'
import { auditLog } from '@/lib/logging/recovery-log'

/**
 * POST /api/ios/:id/addressed
 *
 * Mark a Failed IO as "Addressed" — its underlying problem has been resolved
 * (part arrived, wiring redone) and it is now ready for a tester to re-check.
 *
 * This is a WORKFLOW transition, not a live test, so — unlike /test — it does
 * NOT require a PLC connection. The actual re-test (Addressed → Passed/Failed)
 * still goes through /test, which keeps its PLC gate.
 *
 * Authority + sync are identical to the reset path: local SQLite is written
 * first, a durable recovery-log entry is stamped, and the change is queued to
 * PendingSyncs and pushed up to the cloud like any other result. "Addressed"
 * is just a new value in the Result column.
 */
export async function POST(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string)

    if (isNaN(ioId)) {
      return res.status(400).json({ error: 'Invalid IO ID' })
    }

    const body = req.body ?? {}
    const currentUser: string = (body.currentUser as string) || 'Unknown'
    const note = sanitizeComment(body.comments)

    if (note && note.length > 500) {
      return res.status(400).json({ error: 'Note must be 500 characters or fewer' })
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return res.status(404).json({ error: 'IO not found' })
    }

    // Only a Failed IO can be addressed. Re-addressing an already-Addressed IO
    // is a no-op (idempotent — a duplicate tap from the field shouldn't error).
    if (io.Result === TEST_CONSTANTS.RESULT_ADDRESSED) {
      return res.json({
        success: true,
        message: 'IO already marked addressed',
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
          state: null,
        },
      })
    }
    if (io.Result !== TEST_CONSTANTS.RESULT_FAILED) {
      return res.status(409).json({
        error: 'Only a failed IO can be marked Addressed',
      })
    }

    // Multi-MCM aware state lookup (falls back to singleton internally).
    const plcState = getPlcStateForIo(ioId)
    const subsystemId = getMcmIdForIo(ioId) ?? String(io.SubsystemId)

    const timestamp = createTimestamp()
    const newVersion = (io.Version ?? 0) + 1
    const oldComment = io.Comments
    // Keep the failure reason on the row — an Addressed item is still an open
    // (non-passed) failure, so the cloud's Party Responsible / failure filters
    // should keep matching it until it actually re-passes.
    const newComment = note || io.Comments || null

    let testHistoryId: number | bigint = 0
    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ?, Version = ? WHERE id = ?'
      ).run(TEST_CONSTANTS.RESULT_ADDRESSED, timestamp, newComment, newVersion, ioId)

      const histResult = db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy, FailureMode, Source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, TEST_CONSTANTS.RESULT_ADDRESSED, timestamp, oldComment, plcState ?? null, currentUser, io.FailureMode ?? null, 'local')
      testHistoryId = histResult.lastInsertRowid
    })
    txn()

    // Recovery audit — durable JSONL record, independent of SQLite + cloud push.
    auditLog({
      type: 'io.addressed',
      subsystemId,
      ioId,
      user: currentUser,
      result: TEST_CONSTANTS.RESULT_ADDRESSED,
      version: newVersion,
      detail: { note: note || undefined },
    })

    try {
      const info = db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version, FailureMode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        TEST_CONSTANTS.RESULT_ADDRESSED,
        newComment,
        plcState ?? null,
        new Date().toISOString(),
        newVersion - 1,
        io.FailureMode ?? null,
      )
      console.log(
        `[Addressed] PENDING-QUEUED pendingId=${info.lastInsertRowid} ioId=${ioId} ` +
        `result=${TEST_CONSTANTS.RESULT_ADDRESSED} user=${currentUser ?? 'unknown'} version=${newVersion - 1}`,
      )

      try {
        const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
        getCloudSseClient()?.trackPushedId(ioId)
      } catch (e) { console.warn('[Addressed SSE] trackPushedId failed:', e) }

      const key = `io:${ioId}`
      enqueueSyncPush(key, async () => {
        try {
          await drainPendingSyncsForIo(ioId, 'Addressed', currentUser)
        } catch (syncErr) {
          console.warn(`[Addressed] Instant sync error for IO ${ioId}:`, syncErr instanceof Error ? syncErr.message : syncErr)
        }
      })
    } catch (syncError) {
      // SQLite write already succeeded — log loudly so this can't be a silent loss.
      console.error(
        `[Addressed] PENDING-QUEUE-FAIL ioId=${ioId} ` +
        `result=${TEST_CONSTANTS.RESULT_ADDRESSED} user=${currentUser ?? 'unknown'} version=${newVersion - 1} ` +
        `err=${syncError instanceof Error ? syncError.message : String(syncError)}`,
      )
    }

    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'UpdateIO',
          subsystemId,
          id: ioId,
          result: TEST_CONSTANTS.RESULT_ADDRESSED,
          state: plcState ?? '',
          timestamp,
          comments: newComment ?? '',
          // Failure reason persists on an Addressed item — keep the badge.
          failureMode: io.FailureMode ?? null,
        }),
      })
    } catch {
      // WebSocket broadcast is best-effort
    }

    console.log(`IO ${ioId} marked Addressed by ${currentUser}`)

    const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    return res.json({
      success: true,
      message: 'IO marked as addressed',
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
        state: plcState ?? null,
      },
      testHistory: {
        id: Number(testHistoryId),
        ioId,
        result: TEST_CONSTANTS.RESULT_ADDRESSED,
        timestamp,
        testedBy: currentUser,
      },
    })
  } catch (error) {
    console.error('Error marking IO addressed:', error)
    return res.status(500).json({ error: 'Failed to mark IO addressed' })
  }
}
