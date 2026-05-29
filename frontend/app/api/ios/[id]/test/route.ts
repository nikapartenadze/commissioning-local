import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import {
  getClientForIo,
  getMcmIdForIo,
  getMcmTags,
  hasAnyMcm,
} from '@/lib/mcm-registry'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { drainPendingSyncsForIo } from '@/lib/cloud/pending-sync-utils'
import {
  sanitizeComment,
  createTimestamp,
  TEST_CONSTANTS,
  getPlcStateForIo,
} from '@/lib/services/io-test-service'
import { checkInstallGate } from '@/lib/services/install-gate'

/**
 * POST /api/ios/:id/test
 */
export async function POST(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string)

    if (isNaN(ioId)) {
      return res.status(400).json({ error: 'Invalid IO ID' })
    }

    const body = req.body
    const { result, comments, currentUser, failureMode, blockerResponsibleParty, blockerDescription } = body

    if (!result || !['Pass', 'Fail', 'Passed', 'Failed'].includes(result)) {
      return res.status(400).json({ error: 'Invalid result. Must be "Pass" or "Fail"' })
    }

    const normalizedResult = result === 'Pass' || result === 'Passed'
      ? TEST_CONSTANTS.RESULT_PASSED
      : TEST_CONSTANTS.RESULT_FAILED

    if (comments && comments.length > 500) {
      return res.status(400).json({ error: 'Comment must be 500 characters or fewer' })
    }

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io | undefined

    if (!io) {
      return res.status(404).json({ error: 'IO not found' })
    }

    // Multi-MCM: confirm the controller that owns this IO is reachable. If
    // no MCMs are registered, fall back to the legacy singleton check.
    const subsystemId = getMcmIdForIo(ioId) ?? String(io.SubsystemId)
    if (hasAnyMcm()) {
      const ownerClient = getClientForIo(ioId)
      if (!ownerClient || !ownerClient.isConnected) {
        return res.status(400).json({
          error: `MCM ${subsystemId} not connected — connect from the stations page before testing`,
        })
      }
    } else {
      const plcClient = getPlcTags()
      if (!plcClient.tags || plcClient.count === 0) {
        return res.status(400).json({ error: 'PLC not connected — connect to PLC before testing' })
      }
    }

    // Distinguish a plain Fail from an "unpass" (Pass → Fail) early so the
    // install gate, SPARE check, and network-fault check can let the unpass
    // through. Catching a temp install needs to work even when the device
    // currently reports incomplete or faulted — that's the situation the
    // tester is trying to record.
    const isUnpass = normalizedResult === TEST_CONSTANTS.RESULT_FAILED
      && (io.Result === TEST_CONSTANTS.RESULT_PASSED || io.Result === 'Pass' || io.Result === 'Passed')

    // Install-tracker status is informational by default, but operators can
    // opt in via config.requireInstalledForTesting (e.g. CDW5). The gate
    // helper centralizes that policy — SPARE IOs are exempt and the flag
    // defaults off, so existing fleets see no behavior change. Unpass is
    // exempt — the tester is recording that the install was actually wrong.
    if (!isUnpass) {
      const gate = checkInstallGate(io)
      if (!gate.allowed) {
        return res.status(409).json({ error: gate.error })
      }
    }

    if (io.Description?.toUpperCase().includes('SPARE') && normalizedResult === TEST_CONSTANTS.RESULT_PASSED) {
      return res.status(400).json({ error: 'SPARE IOs cannot be passed' })
    }

    {
      const deviceName = io.NetworkDeviceName
      if (deviceName) {
        const hasNetworkDevice = db.prepare(
          'SELECT 1 FROM NetworkPorts WHERE DeviceName = ? LIMIT 1'
        ).get(deviceName)
        if (hasNetworkDevice) {
          // Look for the fault tag in the owning MCM's tag list first, then
          // fall back to the singleton aggregate (single-PLC deployments).
          const ownerTags = hasAnyMcm() ? getMcmTags(subsystemId).tags : getPlcTags().tags
          const faultTag = `${deviceName}:I.ConnectionFaulted`
          const faultState = ownerTags.find(t => t.name === faultTag)
          if (faultState && faultState.state === 'TRUE') {
            return res.status(400).json({
              error: `Cannot test — parent device ${deviceName} has a connection fault. Fix the fault first.`
            })
          }
        }
      }
    }

    // Owner-aware state lookup. Falls back to singleton inside getPlcStateForIo.
    const plcState = getPlcStateForIo(ioId)

    const sanitizedComments = sanitizeComment(comments)
    const timestamp = createTimestamp()

    // Comment stores ONLY the tester's free-text note. The failure reason
    // lives in its own column (the FailureMode field, set below), so it is
    // no longer prepended here. Prepending caused duplicated text like
    // "Mech — mechanical issue" when a tester also typed the reason out.
    const combinedComment = sanitizedComments || ''

    const oldComment = io.Comments
    const newVersion = (io.Version ?? 0) + 1

    // Denormalise the failure reason onto the Ios row so the cloud-side
    // quick filters ('3rd Party', 'Mech') can match without joining
    // TestHistories. On Pass the field is cleared — a passing IO has no
    // active failure reason.
    const newFailureMode = normalizedResult === TEST_CONSTANTS.RESULT_FAILED
      ? (failureMode || null)
      : null
    // Blocker (party + description) only ride along on the cloud sync push —
    // they end up on the shared Devices row (the install-tracker's two
    // columns), NOT on the local Ios row. A regular Fail doesn't send them
    // at all; only Unpass does. Stash them onto the PendingSync below so the
    // cloud push can write Devices.
    const newBlockerResponsibleParty = normalizedResult === TEST_CONSTANTS.RESULT_FAILED
      ? (blockerResponsibleParty || null)
      : null
    const newBlockerDescription = normalizedResult === TEST_CONSTANTS.RESULT_FAILED
      ? (blockerDescription || null)
      : null
    // isUnpass already determined above (used to skip the install gate).
    // We also stamp it on the TestHistory.Source so the per-row history
    // distinguishes a plain Fail from a Pass→Fail correction.
    const historySource = isUnpass ? 'unpass' : 'local'

    let testHistoryId: number | bigint = 0
    const txn = db.transaction(() => {
      db.prepare(
        'UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ?, Version = ?, FailureMode = ? WHERE id = ?'
      ).run(normalizedResult, timestamp, combinedComment || null, newVersion, newFailureMode, ioId)

      const histResult = db.prepare(
        'INSERT INTO TestHistories (IoId, Result, Timestamp, Comments, State, TestedBy, FailureMode, Source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(ioId, normalizedResult, timestamp, oldComment, plcState ?? null, currentUser ?? 'Unknown', failureMode || null, historySource)
      testHistoryId = histResult.lastInsertRowid
    })
    txn()

    const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    try {
      const info = db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version, FailureMode, BlockerResponsibleParty, BlockerDescription) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        normalizedResult,
        combinedComment || null,
        plcState ?? null,
        new Date().toISOString(),
        newVersion - 1,
        newFailureMode,
        newBlockerResponsibleParty,
        newBlockerDescription,
      )
      console.log(
        `[Test] PENDING-QUEUED pendingId=${info.lastInsertRowid} ioId=${ioId} ` +
        `result=${normalizedResult} tester=${currentUser ?? 'unknown'} version=${newVersion - 1}`,
      )

      try {
        const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
        getCloudSseClient()?.trackPushedId(ioId)
      } catch (e) { console.warn('[Test SSE] trackPushedId failed:', e) }

      const key = `io:${ioId}`
      enqueueSyncPush(key, async () => {
        try {
          await drainPendingSyncsForIo(ioId, 'Test', currentUser)
        } catch (syncErr) {
          console.warn(`[Test] Instant sync error for IO ${ioId}:`, syncErr instanceof Error ? syncErr.message : syncErr)
        }
      })
    } catch (syncError) {
      // SQLite IO write already succeeded above — this is the silent-loss
      // vector if we don't log it loudly with full context.
      console.error(
        `[Test] PENDING-QUEUE-FAIL ioId=${ioId} ` +
        `result=${normalizedResult} tester=${currentUser ?? 'unknown'} version=${newVersion - 1} ` +
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
          result: normalizedResult,
          state: plcState ?? '',
          timestamp,
          comments: combinedComment || '',
          // Carry failureMode on the WS event so cross-tab / multi-laptop
          // grids update the Party Responsible badge without a refetch.
          // newFailureMode is already null on Pass/Clear (see above), which
          // is exactly what listeners need to blank the badge.
          failureMode: newFailureMode,
        }),
      })
    } catch {
      // WebSocket broadcast is best-effort
    }

    console.log(`Test recorded for IO ${ioId}: ${normalizedResult} by ${currentUser ?? 'Unknown'}`)

    return res.json({
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
    return res.status(500).json({ error: 'Failed to record test result' })
  }
}
