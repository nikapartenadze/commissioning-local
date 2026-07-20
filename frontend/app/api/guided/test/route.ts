import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { drainPendingSyncsForIo } from '@/lib/cloud/pending-sync-utils'
import { sanitizeComment, createTimestamp, TEST_CONSTANTS } from '@/lib/services/io-test-service'
import { checkInstallGate } from '@/lib/services/install-gate'
import { getMcmIdForIo } from '@/lib/mcm-registry'
import { auditLog } from '@/lib/logging/recovery-log'

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

    const { result, comments, currentUser, failureMode, trade, blockerResponsibleParty, blockerDescription } = body
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

    // MCM ownership. The manual route refuses to write unless the controller
    // that OWNS this IO is connected; guided deliberately drops the
    // PLC-connected requirement (demo / training / no-PLC walking, see above),
    // but it previously dropped the ownership check with it — so `ioId` was
    // taken on trust and a session pointed at one MCM could commit a result to
    // another MCM's IO, with the audit line faithfully attributing it to the
    // victim. Verify the caller's subsystem instead of its connectivity: keeps
    // the no-PLC capability, closes the wrong-MCM write.
    const ownerSubsystemId = getMcmIdForIo(ioId) ?? String(io.SubsystemId)
    const claimedSubsystemId = body.subsystemId != null ? String(body.subsystemId) : null
    if (claimedSubsystemId && claimedSubsystemId !== ownerSubsystemId) {
      console.error(
        `[Guided test] MCM-MISMATCH REJECTED ioId=${ioId} claimed=${claimedSubsystemId} owner=${ownerSubsystemId}`,
      )
      return res.status(409).json({
        error: `This IO belongs to MCM ${ownerSubsystemId}, not MCM ${claimedSubsystemId}. Re-open guided mode for the correct subsystem.`,
      })
    }
    if (!claimedSubsystemId) {
      console.warn(`[Guided test] no subsystemId supplied — ownership unverified for ioId=${ioId}`)
    }

    if (io.Description?.toUpperCase().includes('SPARE') && normalizedResult === TEST_CONSTANTS.RESULT_PASSED) {
      return res.status(400).json({ error: 'SPARE IOs cannot be passed' })
    }

    // Install-tracker status is informational by default, but operators can
    // opt in via config.requireInstalledForTesting (e.g. CDW5). Same gate
    // policy as POST /api/ios/:id/test — kept consistent so guided mode
    // can't sneak past the rule that holds for the main grid.
    const gate = checkInstallGate(io)
    if (!gate.allowed) {
      return res.status(409).json({ error: gate.error })
    }

    // Best-effort PLC state for the history row — null if PLC isn't connected.
    // Mode-aware union (Phase 1.1): registry MCMs (embedded or gateway cache
    // in PLC_MODE=remote), singleton fallback on tablets.
    let plcState: string | null = null
    try {
      const { getLiveTagsUnion } = await import('@/lib/plc-live-tags')
      plcState = getLiveTagsUnion().find(t => t.id === ioId)?.state ?? null
    } catch { /* PLC not available — leave null */ }

    const sanitizedComments = sanitizeComment(comments)
    const timestamp = createTimestamp()

    // Failure reason rides in its OWN column (FailureMode) — parity with the
    // manual route (app/api/ios/:id/test). Previously guided mode folded the
    // reason INTO the comment and never wrote FailureMode anywhere that synced,
    // so every guided Fail reached cloud with ios.failure_mode = NULL and a
    // blank Party Responsible (the 27-NULL CDW5 rows). Comment = free text only.
    const combinedComment = sanitizedComments || ''
    const newFailureMode = normalizedResult === TEST_CONSTANTS.RESULT_FAILED
      ? (failureMode || null)
      : null
    // Discipline + blocker parity with the manual route. These were previously
    // NEVER written by guided mode: Trade was dropped entirely (cloud punchlist
    // Discipline column stayed NULL for every guided Fail) and the blocker pair
    // never reached the PendingSync, so the cloud never wrote the shared Devices
    // row. Same data-loss class as the FailureMode gap fixed above — the fix had
    // been applied to one column and not the other three.
    const newTrade = normalizedResult === TEST_CONSTANTS.RESULT_FAILED
      ? (trade || null)
      : null
    const newBlockerResponsibleParty = normalizedResult === TEST_CONSTANTS.RESULT_FAILED
      ? (blockerResponsibleParty || null)
      : null
    const newBlockerDescription = normalizedResult === TEST_CONSTANTS.RESULT_FAILED
      ? (blockerDescription || null)
      : null

    const oldComment = io.Comments
    const newVersion = (io.Version ?? 0) + 1
    let testHistoryId: number | bigint = 0

    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ?, Version = ?, FailureMode = ?, Trade = ? WHERE id = ?'
      ).run(normalizedResult, timestamp, combinedComment || null, newVersion, newFailureMode, newTrade, ioId)
      const histResult = db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy, FailureMode, Source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, normalizedResult, timestamp, oldComment, plcState, currentUser ?? 'Unknown', newFailureMode, 'guided')
      testHistoryId = histResult.lastInsertRowid
    })
    txn()

    // MCM-aware subsystem id for attribution (registry MCM tag, fallback to the
    // IO's SubsystemId) — same resolution the manual route uses.
    const subsystemId = ownerSubsystemId
    // Failure reason only applies to a Fail result (parity with the manual route,
    // where newFailureMode is null on Pass).
    const auditFailureMode = normalizedResult === TEST_CONSTANTS.RESULT_FAILED
      ? (failureMode || null)
      : null

    // Recovery audit — durable JSONL record of every result, independent of the
    // SQLite row and the cloud push. Guided IO results now get the same 2-week
    // recovery trail + MCM attribution as the manual route (app/api/ios/:id/test).
    auditLog({
      type: 'io.test',
      subsystemId,
      ioId,
      user: currentUser ?? null,
      result: normalizedResult,
      version: newVersion,
      reason: auditFailureMode ?? undefined,
      detail: {
        comments: combinedComment || undefined,
        state: plcState ?? undefined,
        source: 'guided',
      },
    })

    const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    // Cloud sync — best-effort, never block the response
    try {
      const info = db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version, FailureMode, BlockerResponsibleParty, BlockerDescription, Trade) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        normalizedResult,
        combinedComment || null,
        plcState,
        new Date().toISOString(),
        newVersion - 1,
        newFailureMode,
        newBlockerResponsibleParty,
        newBlockerDescription,
        newTrade,
      )
      console.log(
        `[Guided test] PENDING-QUEUED pendingId=${info.lastInsertRowid} ioId=${ioId} ` +
        `result=${normalizedResult} tester=${currentUser ?? 'unknown'} version=${newVersion - 1}`,
      )

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
      console.error(
        `[Guided test] PENDING-QUEUE-FAIL ioId=${ioId} ` +
        `result=${normalizedResult} tester=${currentUser ?? 'unknown'} version=${newVersion - 1} ` +
        `err=${syncError instanceof Error ? syncError.message : String(syncError)}`,
      )
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
          // Per-MCM scoping: without this the payload has no subsystemId, and
          // shouldDeliver() (server-express.ts) treats an id-less frame as a
          // GLOBAL event that bypasses every client's subscription filter — so
          // guided results leaked into central-tool tabs watching other MCMs.
          subsystemId,
          // Forward failureMode so cross-tab Party Responsible badges update in
          // lockstep with Result. This IS denormalised onto the Ios row in the
          // txn above; forward the same computed value so the WS event, the Ios
          // row and the cloud push can never disagree. On Pass it is null.
          failureMode: newFailureMode,
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
