import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * GET /api/cloud/stuck[?subsystemId=]
 *
 * Read-only list of "stuck" sync rows so an operator can SEE what never made
 * it to the cloud (the field complaint: deployed tools "gave up pushing and
 * didn't display"). A row is stuck if it was parked (DeadLettered=1) or has
 * failed at least once (RetryCount>0). Scoped to a subsystem when given.
 *
 * F8 (2026-07-03 sync audit): this used to cover ONLY the IO queue, so parked
 * L2/e-stop/guided/device-blocker rows were invisible and unrecoverable —
 * a parked e-stop check (SAFETY data) had no operator surface at all. Now
 * every durable queue is surfaced, tagged by `queue`. IO rows additionally
 * pair with POST /api/cloud/push-force. Purely a SELECT — never mutates.
 */
export async function GET(req: Request, res: Response) {
  try {
    const subsystemIdParam = req.query.subsystemId
    const subsystemId = subsystemIdParam != null ? parseInt(String(subsystemIdParam), 10) : null
    const scoped = subsystemId != null && Number.isFinite(subsystemId)

    // ── IO queue (joined to Ios for name/subsystem) ──────────────────────
    const ioRows = db.prepare(`
      SELECT ps.id AS pendingId, ps.IoId AS ioId, i.SubsystemId AS subsystemId, i.Name AS ioName,
             ps.TestResult AS localResult, ps.Comments AS localComments, ps.Version AS localVersion,
             ps.InspectorName AS testedBy, ps.RetryCount AS retryCount, ps.DeadLettered AS deadLettered,
             ps.LastError AS lastError, ps.CreatedAt AS createdAt, i.Result AS ioResult
      FROM PendingSyncs ps
      LEFT JOIN Ios i ON i.id = ps.IoId
      ${scoped ? 'WHERE i.SubsystemId = ? AND (ps.DeadLettered = 1 OR ps.RetryCount > 0)' : 'WHERE (ps.DeadLettered = 1 OR ps.RetryCount > 0)'}
      ORDER BY ps.DeadLettered DESC, ps.CreatedAt ASC
    `).all(...(scoped ? [subsystemId] : [])) as Array<Record<string, unknown>>
    const io = ioRows.map((r) => ({ ...r, queue: 'io', forcePushSupported: true }))

    // ── E-stop check queue (SAFETY data — highest recovery priority) ─────
    const estop = (db.prepare(`
      SELECT id AS pendingId, SubsystemId AS subsystemId, ZoneName AS zoneName, CheckTag AS checkTag,
             Result AS localResult, TestedBy AS testedBy, Version AS localVersion,
             RetryCount AS retryCount, DeadLettered AS deadLettered, LastError AS lastError, CreatedAt AS createdAt
      FROM EStopCheckPendingSyncs
      ${scoped ? 'WHERE SubsystemId = ? AND (DeadLettered = 1 OR RetryCount > 0)' : 'WHERE (DeadLettered = 1 OR RetryCount > 0)'}
      ORDER BY DeadLettered DESC, CreatedAt ASC
    `).all(...(scoped ? [subsystemId] : [])) as Array<Record<string, unknown>>)
      .map((r) => ({ ...r, queue: 'estop', forcePushSupported: false }))

    // ── Guided-task-state queue ──────────────────────────────────────────
    const guided = (db.prepare(`
      SELECT id AS pendingId, SubsystemId AS subsystemId, TaskId AS taskId, Status AS localResult,
             ActorName AS testedBy, RetryCount AS retryCount, DeadLettered AS deadLettered,
             LastError AS lastError, CreatedAt AS createdAt
      FROM GuidedTaskStatePendingSyncs
      ${scoped ? 'WHERE SubsystemId = ? AND (DeadLettered = 1 OR RetryCount > 0)' : 'WHERE (DeadLettered = 1 OR RetryCount > 0)'}
      ORDER BY DeadLettered DESC, CreatedAt ASC
    `).all(...(scoped ? [subsystemId] : [])) as Array<Record<string, unknown>>)
      .map((r) => ({ ...r, queue: 'guided', forcePushSupported: false }))

    // ── Device-blocker queue (VFD bump-test) — no numeric join, has its own
    // SubsystemId column. ──────────────────────────────────────────────────
    const blocker = (db.prepare(`
      SELECT id AS pendingId, SubsystemId AS subsystemId, DeviceName AS deviceName, Op AS op,
             BlockerResponsibleParty AS localParty, BlockerDescription AS localDescription,
             UpdatedBy AS testedBy, RetryCount AS retryCount, DeadLettered AS deadLettered,
             LastError AS lastError, CreatedAt AS createdAt
      FROM DeviceBlockerPendingSyncs
      ${scoped ? 'WHERE SubsystemId = ? AND (DeadLettered = 1 OR RetryCount > 0)' : 'WHERE (DeadLettered = 1 OR RetryCount > 0)'}
      ORDER BY DeadLettered DESC, CreatedAt ASC
    `).all(...(scoped ? [subsystemId] : [])) as Array<Record<string, unknown>>)
      .map((r) => ({ ...r, queue: 'device-blocker', forcePushSupported: false }))

    // ── L2/FV cell queue — no subsystem FK (keyed by cloud device/column);
    // include only when unscoped OR the device resolves to the subsystem. ──
    const l2Rows = db.prepare(`
      SELECT lp.id AS pendingId, lp.CloudDeviceId AS cloudDeviceId, lp.CloudColumnId AS cloudColumnId,
             lp.Value AS localResult, lp.UpdatedBy AS testedBy, lp.Version AS localVersion,
             lp.RetryCount AS retryCount, lp.DeadLettered AS deadLettered, lp.LastError AS lastError,
             lp.CreatedAt AS createdAt, d.SubsystemId AS subsystemId, d.DeviceName AS deviceName
      FROM L2PendingSyncs lp
      LEFT JOIN L2Devices d ON d.CloudId = lp.CloudDeviceId
      WHERE (lp.DeadLettered = 1 OR lp.RetryCount > 0)
      ORDER BY lp.DeadLettered DESC, lp.CreatedAt ASC
    `).all() as Array<Record<string, unknown>>
    const l2 = l2Rows
      .filter((r) => !scoped || r.subsystemId == null || Number(r.subsystemId) === subsystemId)
      .map((r) => ({ ...r, queue: 'l2', forcePushSupported: false }))

    const items = [...io, ...estop, ...guided, ...blocker, ...l2] as Array<Record<string, unknown>>
    const byQueue = { io: io.length, estop: estop.length, guided: guided.length, 'device-blocker': blocker.length, l2: l2.length }

    return res.json({
      success: true,
      count: items.length,
      deadLettered: items.filter((r) => r.deadLettered === 1).length,
      byQueue,
      items,
    })
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to list stuck syncs' })
  }
}
