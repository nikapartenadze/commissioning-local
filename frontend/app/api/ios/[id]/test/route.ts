import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'
import { drainPendingSyncsForIo } from '@/lib/cloud/pending-sync-utils'
import {
  sanitizeComment,
  createTimestamp,
  TEST_CONSTANTS
} from '@/lib/services/io-test-service'

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
    const { result, comments, currentUser, failureMode } = body

    if (!result || !['Pass', 'Fail', 'Passed', 'Failed'].includes(result)) {
      return res.status(400).json({ error: 'Invalid result. Must be "Pass" or "Fail"' })
    }

    const normalizedResult = result === 'Pass' || result === 'Passed'
      ? TEST_CONSTANTS.RESULT_PASSED
      : TEST_CONSTANTS.RESULT_FAILED

    if (comments && comments.length > 500) {
      return res.status(400).json({ error: 'Comment must be 500 characters or fewer' })
    }

    const plcClient = getPlcTags()
    if (!plcClient.tags || plcClient.count === 0) {
      return res.status(400).json({ error: 'PLC not connected — connect to PLC before testing' })
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
          const client = getPlcTags()
          const faultTag = `${deviceName}:I.ConnectionFaulted`
          const faultState = client.tags.find(t => t.name === faultTag)
          if (faultState && faultState.state === 'TRUE') {
            return res.status(400).json({
              error: `Cannot test — parent device ${deviceName} has a connection fault. Fix the fault first.`
            })
          }
        }
      }
    }

    const { tags } = getPlcTags()
    const tag = tags.find(t => t.id === ioId)
    const plcState = tag?.state

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
      ).run(ioId, normalizedResult, timestamp, oldComment, plcState ?? null, currentUser ?? 'Unknown', failureMode || null, 'local')
      testHistoryId = histResult.lastInsertRowid
    })
    txn()

    const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(ioId) as Io

    try {
      db.prepare(
        'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        ioId,
        currentUser || null,
        normalizedResult,
        combinedComment || null,
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
        try {
          await drainPendingSyncsForIo(ioId, 'Test', currentUser)
        } catch (syncErr) {
          console.warn(`[Test] Instant sync error for IO ${ioId}:`, syncErr instanceof Error ? syncErr.message : syncErr)
        }
      })
    } catch (syncError) {
      console.error('[Test] Failed to create PendingSync:', syncError)
    }

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
