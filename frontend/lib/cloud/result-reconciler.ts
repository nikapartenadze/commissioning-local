/**
 * Orphaned-result reconciler (local → cloud, queue-independent).
 *
 * The background push loop ONLY drains the PendingSyncs queue. Nothing
 * reconciles the actual `Ios.Result`/`Comments` (the locally-owned source of
 * truth for test results) back to the cloud. So a result that left the queue
 * WITHOUT reaching the cloud — a legacy retry-cap delete, a permanent-reject
 * delete, any historical drop — becomes a permanent ORPHAN: present locally,
 * absent on cloud, with no queue row. It's invisible to the "pending" count,
 * never re-pushed, and only the destructive-pull guard ever surfaces it (as a
 * block, with no way to push it). That's the "0 in queue but pull keeps warning"
 * trap operators hit after a long offline stint.
 *
 * This module closes the gap: it runs the SAME local-vs-cloud diff the pull
 * guard uses, and for every orphaned result/comment it RE-ENQUEUES a PendingSync
 * row (the proven grid-save path) so the normal push loop delivers it. Net
 * effect: every pass/fail collected offline lands on reconnect — queue row or
 * not.
 *
 * Safe by construction:
 *   - never touches `Ios` (read-only on the result source of truth);
 *   - skips any IO that already has a PendingSync row (active OR parked) so it
 *     can't duplicate queued work or revive a row the cloud permanently rejected;
 *   - enqueues with the CLOUD's current version as the base (maximizes
 *     first-try acceptance; B7 reconcile rebases any miss, local-wins);
 *   - best-effort: a cloud-fetch failure changes nothing.
 */

import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types'
import { auditLog } from '@/lib/logging/recovery-log'

/** Local Ios row, with the fields a faithful re-push must carry. */
export interface LocalResultRow {
  id: number
  Result: string | null
  Comments: string | null
  TestedBy: string | null
  Timestamp: string | null
  Version: number
  Trade: string | null
  FailureMode: string | null
}

/** Cloud IO state from GET /api/sync/subsystem/:id. */
export interface CloudIoState {
  id: number | string
  result?: string | null
  comments?: string | null
  version?: number
}

/** One PendingSync row to create so the push loop re-delivers an orphan. */
export interface ReconcileEnqueue {
  ioId: number
  /** Pass/Fail/etc. for a result orphan, or a 'Comment …' op for a comment orphan. */
  testResult: string
  comments: string | null
  inspectorName: string | null
  timestamp: string | null
  /** Base version = the cloud's CURRENT version for this IO. */
  version: number
  failureMode: string | null
  trade: string | null
  kind: 'result' | 'comment'
}

const isEmpty = (v: string | null | undefined): boolean => v == null || v.trim() === ''

/**
 * Pure diff: given local rows, the cloud payload, and the set of IO ids that
 * already have a PendingSync row, return the rows to re-enqueue.
 *
 *   - result orphan : local has a result, cloud has none → re-push the result
 *                     (carries the comment too).
 *   - comment orphan: local has a comment the cloud lacks, but the result is
 *                     NOT orphaned (already on cloud or absent locally) → push a
 *                     'Comment Added' op so the comment isn't lost on its own.
 *
 * A *different* cloud result is never touched — that's normal last-write-wins
 * and the cloud value is the newer authority (same rule as the pull guard).
 */
export function computeReconcileEnqueues(
  local: readonly LocalResultRow[],
  cloudIos: readonly CloudIoState[],
  existingPendingIoIds: ReadonlySet<number>,
): ReconcileEnqueue[] {
  const cloudById = new Map<number, CloudIoState>(
    cloudIos.map((io) => [Number(io.id), io]),
  )

  const out: ReconcileEnqueue[] = []
  for (const row of local) {
    if (existingPendingIoIds.has(row.id)) continue

    const cloud = cloudById.get(row.id)
    const cloudVersion = Number(cloud?.version) || 0
    const cloudResultEmpty = isEmpty(cloud?.result)
    const cloudCommentEmpty = isEmpty(cloud?.comments)
    const hasResult = !isEmpty(row.Result)
    const hasComment = !isEmpty(row.Comments)

    if (hasResult && cloudResultEmpty) {
      out.push({
        ioId: row.id,
        testResult: row.Result as string,
        comments: row.Comments,
        inspectorName: row.TestedBy,
        timestamp: row.Timestamp,
        version: cloudVersion,
        failureMode: row.FailureMode,
        trade: row.Trade,
        kind: 'result',
      })
    } else if (hasComment && cloudCommentEmpty) {
      // Result already on cloud (or none locally), but the comment never made
      // it. Push a comment-op so the field note survives.
      out.push({
        ioId: row.id,
        testResult: 'Comment Added',
        comments: row.Comments,
        inspectorName: row.TestedBy,
        timestamp: row.Timestamp,
        version: cloudVersion,
        failureMode: null,
        trade: row.Trade,
        kind: 'comment',
      })
    }
  }
  return out
}

export interface ReconcileResult {
  ok: boolean
  subsystemId: number
  /** Number of orphaned results/comments re-enqueued for push. */
  enqueued: number
  error?: string
}

const insertPendingStmt = () => db.prepare(
  `INSERT INTO PendingSyncs
     (IoId, InspectorName, TestResult, Comments, State, Timestamp, CreatedAt, RetryCount, Version, FailureMode, Trade)
   VALUES (@IoId, @InspectorName, @TestResult, @Comments, NULL, @Timestamp, @CreatedAt, 0, @Version, @FailureMode, @Trade)`,
)

/**
 * Reconcile one subsystem's orphaned local results/comments into the queue.
 * Fetches the cloud payload, diffs it against local, and inserts a PendingSync
 * row for each orphan so the normal push loop delivers it. Best-effort — a
 * cloud failure leaves local untouched and returns ok:false.
 */
export async function reconcileOrphanedResults(subsystemId: number): Promise<ReconcileResult> {
  const cfg = await configService.getConfig()
  const remoteUrl = (cfg.remoteUrl || EMBEDDED_REMOTE_URL).replace(/\/+$/, '')
  const apiPassword = cfg.apiPassword || ''
  if (!remoteUrl) return { ok: false, subsystemId, enqueued: 0, error: 'Cloud URL not configured' }
  if (!apiPassword) return { ok: false, subsystemId, enqueued: 0, error: 'API key not configured' }

  let res: globalThis.Response
  try {
    res = await fetch(`${remoteUrl}/api/sync/subsystem/${subsystemId}`, {
      method: 'GET',
      headers: { 'X-API-Key': apiPassword },
      signal: AbortSignal.timeout(25_000),
    })
  } catch (err) {
    return { ok: false, subsystemId, enqueued: 0, error: `Cloud unreachable: ${(err as Error).message}` }
  }
  if (!res.ok) return { ok: false, subsystemId, enqueued: 0, error: `Cloud returned ${res.status}` }

  let cloudIos: CloudIoState[]
  try {
    const body = await res.json()
    cloudIos = (body.ios || body.Ios || []) as CloudIoState[]
  } catch {
    return { ok: false, subsystemId, enqueued: 0, error: 'Malformed cloud payload' }
  }

  const local = db.prepare(
    `SELECT id, Result, Comments, TestedBy, Timestamp, Version, Trade, FailureMode
       FROM Ios
      WHERE SubsystemId = ?
        AND ((Result IS NOT NULL AND Result != '') OR (Comments IS NOT NULL AND TRIM(Comments) != ''))`,
  ).all(subsystemId) as LocalResultRow[]

  // Skip IOs that already carry ANY PendingSync row (active or parked) — don't
  // duplicate queued work, and don't revive a permanently-rejected (parked) row.
  const pendingIds = db.prepare(
    `SELECT DISTINCT ps.IoId FROM PendingSyncs ps
       JOIN Ios i ON i.id = ps.IoId
      WHERE i.SubsystemId = ?`,
  ).all(subsystemId) as Array<{ IoId: number }>
  const existing = new Set<number>(pendingIds.map((r) => r.IoId))

  const enqueues = computeReconcileEnqueues(local, cloudIos, existing)
  if (enqueues.length === 0) return { ok: true, subsystemId, enqueued: 0 }

  const now = new Date().toISOString()
  const ins = insertPendingStmt()
  const run = db.transaction((rows: ReconcileEnqueue[]) => {
    for (const e of rows) {
      ins.run({
        IoId: e.ioId,
        InspectorName: e.inspectorName,
        TestResult: e.testResult,
        Comments: e.comments,
        Timestamp: e.timestamp,
        CreatedAt: now,
        Version: e.version,
        FailureMode: e.failureMode,
        Trade: e.trade,
      })
    }
  })
  run(enqueues)

  // Durable audit trail — these are recovered orphans, so leave a record of what
  // was re-queued and why (parallel to the sync.push.drop/park audit lines).
  for (const e of enqueues) {
    auditLog({
      type: 'sync.reconcile.enqueue',
      ioId: e.ioId,
      subsystemId,
      version: e.version,
      result: e.testResult,
      user: e.inspectorName,
      reason: `reconciler: orphaned ${e.kind} not on cloud — re-enqueued for push`,
      detail: { comments: e.comments, kind: e.kind },
    })
  }

  console.warn(
    `[Reconciler] subsystem ${subsystemId}: re-enqueued ${enqueues.length} orphaned ` +
    `result/comment(s) the cloud was missing (will push on the next cycle)`,
  )
  return { ok: true, subsystemId, enqueued: enqueues.length }
}

/**
 * Reconcile every subsystem this tool is responsible for: the configured MCM
 * list on a central server, or the single config.subsystemId on a tablet.
 * Used by the on-demand endpoint and the auto-sync reconnect/safety hooks.
 */
export async function reconcileConfiguredSubsystems(): Promise<ReconcileResult[]> {
  let subsystemIds: number[] = []
  try {
    const mcms = await configService.getMcms()
    subsystemIds = (mcms || [])
      .filter((m) => m.enabled !== false && m.subsystemId)
      .map((m) => parseInt(String(m.subsystemId), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    /* fall through to the single-subsystem config below */
  }
  if (subsystemIds.length === 0) {
    const cfg = await configService.getConfig()
    const sid = parseInt(String(cfg.subsystemId ?? ''), 10)
    if (Number.isFinite(sid) && sid > 0) subsystemIds = [sid]
  }

  const results: ReconcileResult[] = []
  for (const sid of subsystemIds) {
    results.push(await reconcileOrphanedResults(sid))
  }
  return results
}
