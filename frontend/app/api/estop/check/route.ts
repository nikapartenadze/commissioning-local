import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * POST /api/estop/check
 *
 * Record a pass/fail result for a single Emergency Pull Cord (EPC). The
 * tester pulls a cord, watches the VFDs go into STO in the EStop view, and
 * then commits the pass/fail observation here. Result is binary (pass/fail)
 * plus optional comments and an optional failureMode (e.g. "Needs proper
 * tension") chosen from the standard failure-reasons dropdown.
 *
 * Body: { subsystemId, zoneName, checkTag, result: 'pass' | 'fail',
 *         comments?: string, failureMode?: string,
 *         testedBy?: string, reset?: boolean }
 *
 * If `reset: true`, the row is cleared back to null (Result, Comments,
 * FailureMode, TestedBy, TestedAt all NULL) but the row itself stays so
 * Version keeps incrementing.
 *
 * Identity is the composite (SubsystemId, ZoneName, CheckTag).
 */

const upsertStmt = db.prepare(`
  INSERT INTO EStopEpcChecks (SubsystemId, ZoneName, CheckTag, Result, Comments, FailureMode, TestedBy, TestedAt, Version, CreatedAt, UpdatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), 1, datetime('now'), datetime('now'))
  ON CONFLICT(SubsystemId, ZoneName, CheckTag) DO UPDATE SET
    Result = excluded.Result,
    Comments = excluded.Comments,
    FailureMode = excluded.FailureMode,
    TestedBy = excluded.TestedBy,
    TestedAt = excluded.TestedAt,
    Version = EStopEpcChecks.Version + 1,
    UpdatedAt = datetime('now')
`)

const resetStmt = db.prepare(`
  INSERT INTO EStopEpcChecks (SubsystemId, ZoneName, CheckTag, Result, Comments, FailureMode, TestedBy, TestedAt, Version, CreatedAt, UpdatedAt)
  VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, datetime('now'), datetime('now'))
  ON CONFLICT(SubsystemId, ZoneName, CheckTag) DO UPDATE SET
    Result = NULL,
    Comments = NULL,
    FailureMode = NULL,
    TestedBy = NULL,
    TestedAt = NULL,
    Version = EStopEpcChecks.Version + 1,
    UpdatedAt = datetime('now')
`)

export async function POST(req: Request, res: Response) {
  try {
    const { subsystemId, zoneName, checkTag, result, comments, failureMode, testedBy, reset } = req.body as {
      subsystemId?: number
      zoneName?: string
      checkTag?: string
      result?: 'pass' | 'fail'
      comments?: string
      failureMode?: string
      testedBy?: string
      reset?: boolean
    }

    if (!Number.isInteger(subsystemId) || !subsystemId || subsystemId <= 0) {
      return res.status(400).json({ error: 'subsystemId required (positive integer)' })
    }
    if (!zoneName || typeof zoneName !== 'string') {
      return res.status(400).json({ error: 'zoneName required (string)' })
    }
    if (!checkTag || typeof checkTag !== 'string') {
      return res.status(400).json({ error: 'checkTag required (string)' })
    }

    if (reset) {
      resetStmt.run(subsystemId, zoneName, checkTag)
      return res.json({ success: true, reset: true })
    }

    if (result !== 'pass' && result !== 'fail') {
      return res.status(400).json({ error: "result must be 'pass' or 'fail' (or pass reset: true)" })
    }

    // Pass results never carry a failureMode — defensively null it on pass.
    const storedFailureMode = result === 'fail' ? (failureMode ?? null) : null

    upsertStmt.run(
      subsystemId,
      zoneName,
      checkTag,
      result,
      comments ?? null,
      storedFailureMode,
      testedBy ?? null,
    )
    return res.json({ success: true, result, failureMode: storedFailureMode, testedBy: testedBy ?? null })
  } catch (error) {
    console.error('[EStopCheck] Error:', error)
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to record EStop check',
    })
  }
}
