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

// ─────────────────────────────────────────────────────────────────────────────
// L2/FV orphan reconciler (F9, 2026-07-03 sync audit).
//
// Same trap as IO results, FV flavor (the MCM17 class): an FV cell whose
// L2PendingSyncs row was lost (legacy cap-drop, crash between write and
// enqueue) is present locally, absent on cloud, invisible to the pending
// count, and never re-pushed. Diff local mapped cells against the cloud L2
// payload and re-enqueue what the cloud is missing. Unmapped cells (no
// CloudId) can never sync and are NOT enqueued — they're journaled as
// l2.push.drop at write time and surfaced by the FV pull guard instead.
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalL2CellRow {
  deviceCloudId: number
  columnCloudId: number
  value: string
  updatedBy: string | null
}

export interface CloudL2CellState {
  deviceId: number | string
  columnId: number | string
  value?: string | null
  version?: number | string
}

export interface L2ReconcileEnqueue {
  cloudDeviceId: number
  cloudColumnId: number
  value: string
  updatedBy: string | null
  /** Base version = the cloud's CURRENT cell version (0 for a missing cell). */
  version: number
}

/**
 * Pure diff: local mapped, non-empty FV cells the cloud has no value for
 * (cell missing or empty), excluding cells that already have a queue row.
 * A *different* cloud value is never touched — normal last-write-wins.
 */
export function computeL2ReconcileEnqueues(
  local: readonly LocalL2CellRow[],
  cloudCells: readonly CloudL2CellState[],
  existingQueuedKeys: ReadonlySet<string>,
): L2ReconcileEnqueue[] {
  const cloudByKey = new Map<string, CloudL2CellState>(
    cloudCells.map((c) => [`${Number(c.deviceId)}-${Number(c.columnId)}`, c]),
  )
  const out: L2ReconcileEnqueue[] = []
  for (const row of local) {
    if (isEmpty(row.value)) continue
    const key = `${row.deviceCloudId}-${row.columnCloudId}`
    if (existingQueuedKeys.has(key)) continue
    const cloud = cloudByKey.get(key)
    if (cloud && !isEmpty(cloud.value as string | null)) continue
    out.push({
      cloudDeviceId: row.deviceCloudId,
      cloudColumnId: row.columnCloudId,
      value: row.value,
      updatedBy: row.updatedBy,
      version: Number(cloud?.version) || 0,
    })
  }
  return out
}

export interface L2ReconcileResult {
  ok: boolean
  subsystemId: number
  enqueued: number
  error?: string
}

/**
 * Reconcile one subsystem's orphaned FV cells into the L2 queue. Best-effort —
 * a cloud failure leaves local untouched and returns ok:false.
 */
export async function reconcileOrphanedL2Cells(subsystemId: number): Promise<L2ReconcileResult> {
  const cfg = await configService.getConfig()
  const remoteUrl = (cfg.remoteUrl || EMBEDDED_REMOTE_URL).replace(/\/+$/, '')
  const apiPassword = cfg.apiPassword || ''
  if (!remoteUrl) return { ok: false, subsystemId, enqueued: 0, error: 'Cloud URL not configured' }
  if (!apiPassword) return { ok: false, subsystemId, enqueued: 0, error: 'API key not configured' }

  let res: globalThis.Response
  try {
    res = await fetch(`${remoteUrl}/api/sync/l2/${subsystemId}`, {
      method: 'GET',
      headers: { 'X-API-Key': apiPassword },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    return { ok: false, subsystemId, enqueued: 0, error: `Cloud unreachable: ${(err as Error).message}` }
  }
  if (!res.ok) return { ok: false, subsystemId, enqueued: 0, error: `Cloud returned ${res.status}` }

  let cloudCells: CloudL2CellState[]
  try {
    const body = await res.json()
    if (body?.success === false) return { ok: false, subsystemId, enqueued: 0, error: body.error || 'cloud success=false' }
    cloudCells = (body.cellValues || []) as CloudL2CellState[]
  } catch {
    return { ok: false, subsystemId, enqueued: 0, error: 'Malformed cloud payload' }
  }

  const local = db.prepare(
    `SELECT d.CloudId as deviceCloudId, c.CloudId as columnCloudId,
            v.Value as value, v.UpdatedBy as updatedBy
       FROM L2CellValues v
       JOIN L2Devices d ON d.id = v.DeviceId
       JOIN L2Columns c ON c.id = v.ColumnId
      WHERE (d.SubsystemId = ? OR d.SubsystemId IS NULL)
        AND d.CloudId IS NOT NULL AND c.CloudId IS NOT NULL
        AND v.Value IS NOT NULL AND TRIM(v.Value) != ''`,
  ).all(subsystemId) as LocalL2CellRow[]

  const queued = db.prepare('SELECT CloudDeviceId, CloudColumnId FROM L2PendingSyncs')
    .all() as Array<{ CloudDeviceId: number; CloudColumnId: number }>
  const existing = new Set<string>(queued.map((r) => `${r.CloudDeviceId}-${r.CloudColumnId}`))

  const enqueues = computeL2ReconcileEnqueues(local, cloudCells, existing)
  if (enqueues.length === 0) return { ok: true, subsystemId, enqueued: 0 }

  const ins = db.prepare(
    `INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, UpdatedBy, Version, CreatedAt, RetryCount)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  )
  const now = new Date().toISOString()
  const run = db.transaction((rows: L2ReconcileEnqueue[]) => {
    for (const e of rows) ins.run(e.cloudDeviceId, e.cloudColumnId, e.value, e.updatedBy, e.version, now)
  })
  run(enqueues)

  for (const e of enqueues) {
    auditLog({
      type: 'l2.reconcile.enqueue',
      subsystemId,
      version: e.version,
      user: e.updatedBy,
      reason: 'reconciler: orphaned FV cell not on cloud — re-enqueued for push',
      detail: { cloudDeviceId: e.cloudDeviceId, cloudColumnId: e.cloudColumnId, value: e.value },
    })
  }

  console.warn(
    `[Reconciler] subsystem ${subsystemId}: re-enqueued ${enqueues.length} orphaned ` +
    `FV cell(s) the cloud was missing (will push on the next cycle)`,
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
    // FV orphans (F9): best-effort, independent of the IO pass — an L2 fetch
    // failure must not block IO reconciliation for the next subsystem.
    try {
      await reconcileOrphanedL2Cells(sid)
    } catch (err) {
      console.warn(`[Reconciler] L2 reconcile failed for subsystem ${sid}:`, err instanceof Error ? err.message : err)
    }
  }
  return results
}
