import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { enqueueSyncPush } from '@/lib/cloud/sync-queue'

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

// ── Cloud sync helpers (mirror the L2 cell pattern) ──────────────────
// After the local upsert, read back the freshly-written row, enqueue a
// pending-sync row, and push it to the cloud. Non-OK responses leave the
// pending row in place for the periodic background drain (auto-sync.ts) —
// the local write is never blocked.
const readCheck = db.prepare(
  'SELECT Result, Comments, FailureMode, TestedBy, TestedAt, Version FROM EStopEpcChecks WHERE SubsystemId = ? AND ZoneName = ? AND CheckTag = ?',
)
const insertPendingSync = db.prepare(
  `INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CheckTag, Result, Comments, FailureMode, TestedBy, TestedAt, Version)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)
// Drop ALL pending rows for this check once the cloud accepts the latest —
// intermediate rows are stale (same dedupe semantics as the L2 path).
const deleteAllPendingForCheck = db.prepare(
  'DELETE FROM EStopCheckPendingSyncs WHERE SubsystemId = ? AND ZoneName = ? AND CheckTag = ?',
)
const getOldestPendingVersion = db.prepare(
  'SELECT MIN(Version) as version FROM EStopCheckPendingSyncs WHERE SubsystemId = ? AND ZoneName = ? AND CheckTag = ?',
)
const incrementPendingRetry = db.prepare(
  'UPDATE EStopCheckPendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE SubsystemId = ? AND ZoneName = ? AND CheckTag = ?',
)

interface CheckRow {
  Result: string | null
  Comments: string | null
  FailureMode: string | null
  TestedBy: string | null
  TestedAt: string | null
  Version: number
}

/**
 * Enqueue a pending-sync row for the just-written EPC check and fire an
 * immediate, version-aware push to the cloud. Subsystem-scoped; retry-safe.
 */
export function enqueueEstopCheckSync(subsystemId: number, zoneName: string, checkTag: string): void {
  const row = readCheck.get(subsystemId, zoneName, checkTag) as CheckRow | undefined
  if (!row) return

  // Base version the cloud last had = the row's Version BEFORE this write.
  insertPendingSync.run(
    subsystemId,
    zoneName,
    checkTag,
    row.Result,
    row.Comments,
    row.FailureMode,
    row.TestedBy,
    row.TestedAt,
    row.Version - 1,
  )

  const key = `estopcheck:${subsystemId}-${zoneName}-${checkTag}`
  enqueueSyncPush(key, async () => {
    // Always push the LATEST local row (handles rapid edits).
    const latest = readCheck.get(subsystemId, zoneName, checkTag) as CheckRow | undefined
    if (!latest) return

    // Use the OLDEST pending version as the base — that's what the cloud
    // actually has (see the L2 path for the rationale).
    const oldest = getOldestPendingVersion.get(subsystemId, zoneName, checkTag) as { version: number | null } | undefined
    const baseVersion = oldest?.version ?? (latest.Version - 1)

    const config = await configService.getConfig()
    if (!config.remoteUrl) return

    let resp: globalThis.Response
    try {
      resp = await fetch(`${config.remoteUrl}/api/sync/estop-checks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiPassword || '' },
        body: JSON.stringify({
          subsystemId,
          checks: [{
            zoneName,
            checkTag,
            // Cloud /api/sync/estop-checks validates result ∈ {Passed,Failed};
            // local EStop tables store lowercase pass/fail — normalize here.
            result: latest.Result === 'pass' ? 'Passed' : latest.Result === 'fail' ? 'Failed' : latest.Result,
            comments: latest.Comments,
            failureMode: latest.FailureMode,
            testedBy: latest.TestedBy,
            testedAt: latest.TestedAt,
            version: baseVersion,
          }],
        }),
        signal: AbortSignal.timeout(10000),
      })
    } catch (err) {
      // Network error / timeout — leave the pending row for background retry.
      console.warn(`[EStopCheck Sync] Network error pushing ${zoneName}/${checkTag}:`, err instanceof Error ? err.message : err)
      return
    }

    if (!resp.ok) {
      // Cloud/proxy did not accept — keep the pending row; background drain retries.
      console.warn(`[EStopCheck Sync] HTTP ${resp.status} pushing ${zoneName}/${checkTag} — leaving pending for background retry`)
      try { incrementPendingRetry.run(`HTTP ${resp.status}`, subsystemId, zoneName, checkTag) } catch { /* best-effort */ }
      return
    }

    // Accepted — drop all pending rows for this check.
    try {
      deleteAllPendingForCheck.run(subsystemId, zoneName, checkTag)
    } catch (err) {
      console.warn(`[EStopCheck Sync] Failed to clear pending for ${zoneName}/${checkTag}:`, err instanceof Error ? err.message : err)
    }
  })
}

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
      enqueueEstopCheckSync(subsystemId, zoneName, checkTag)
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
    enqueueEstopCheckSync(subsystemId, zoneName, checkTag)
    return res.json({ success: true, result, failureMode: storedFailureMode, testedBy: testedBy ?? null })
  } catch (error) {
    console.error('[EStopCheck] Error:', error)
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to record EStop check',
    })
  }
}
