import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * GET /api/cloud/stuck[?subsystemId=]
 *
 * Read-only list of "stuck" IO sync rows so an operator can SEE what never made
 * it to the cloud (the field complaint: deployed tools "gave up pushing and
 * didn't display"). A row is stuck if it was parked (DeadLettered=1) or has
 * failed at least once (RetryCount>0). Scoped to a subsystem when given.
 *
 * Pairs with POST /api/cloud/push-force to let the operator force these up.
 * Purely a SELECT — never mutates.
 */
export async function GET(req: Request, res: Response) {
  try {
    const subsystemIdParam = req.query.subsystemId
    const subsystemId = subsystemIdParam != null ? parseInt(String(subsystemIdParam), 10) : null

    const where = subsystemId && Number.isFinite(subsystemId)
      ? 'WHERE i.SubsystemId = ? AND (ps.DeadLettered = 1 OR ps.RetryCount > 0)'
      : 'WHERE (ps.DeadLettered = 1 OR ps.RetryCount > 0)'
    const args = subsystemId && Number.isFinite(subsystemId) ? [subsystemId] : []

    const rows = db.prepare(`
      SELECT ps.id AS pendingId, ps.IoId AS ioId, i.SubsystemId AS subsystemId, i.Name AS ioName,
             ps.TestResult AS localResult, ps.Comments AS localComments, ps.Version AS localVersion,
             ps.InspectorName AS testedBy, ps.RetryCount AS retryCount, ps.DeadLettered AS deadLettered,
             ps.LastError AS lastError, ps.CreatedAt AS createdAt,
             i.Result AS ioResult
      FROM PendingSyncs ps
      LEFT JOIN Ios i ON i.id = ps.IoId
      ${where}
      ORDER BY ps.DeadLettered DESC, ps.CreatedAt ASC
    `).all(...args) as Array<Record<string, unknown>>

    return res.json({
      success: true,
      count: rows.length,
      deadLettered: rows.filter((r) => r.deadLettered === 1).length,
      items: rows,
    })
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to list stuck syncs' })
  }
}
