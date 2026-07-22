import { db } from '@/lib/db-sqlite'
import { classify } from '@/lib/sync/queue-inspector'
import { auditLog } from '@/lib/logging/recovery-log'

/**
 * ONE-TIME BACKLOG RE-ADJUDICATION (2026-07-22).
 *
 * The rejection-code routing shipped alongside the terminal `Resolved` state
 * only fixes NEW rejections. It does nothing for the STANDING BACKLOG: a deleted
 * IO never answered HTTP 404 — /api/sync/update replies HTTP 200 with
 * `rejected: [{ reason: 'IO not found', permanent: true }]` — so those rows fell
 * through to deadLetter() and are DeadLettered=1. Dead-lettered rows are never
 * retried, so the new code path NEVER SEES THEM and they sit in the
 * "needs a human" bucket forever. The queue is supposed to be a few minutes
 * deep; anything that cannot sync should be gone from view, not parked in an
 * unowned limbo nobody can clear.
 *
 * Two populations, deliberately treated DIFFERENTLY:
 *
 * (a) Orphaned=1 AND Resolved=0 — the cloud ALREADY PROVED these targets are
 *     gone (403/404/410 or a delete tombstone). Marking them Resolved is pure
 *     bookkeeping on a conclusion that was already reached and recorded. Safe,
 *     unguarded, idempotent.
 *
 * (b) DeadLettered=1 AND Orphaned=0 whose LastError classifies `gone_on_cloud`.
 *     These are NOT bulk-resolved. Bulk-resolving would mean trusting the
 *     English-string matching in queue-inspector.classify() — the exact thing
 *     this whole change exists to stop routing on — and a single false positive
 *     would SILENTLY HIDE A REAL UNSYNCED TEST. That is the 2026-05-21 failure
 *     mode with extra steps.
 *
 *     Instead they are RE-ADJUDICATED: released back to the active queue ONCE
 *     (DeadLettered→0, RetryCount→0, LastError→NULL) so they hit the cloud again
 *     and get a TRUSTWORTHY, machine-readable verdict. A genuinely-deleted IO
 *     comes back `io_not_found` → orphan() → Resolved, automatically and with
 *     proof. A misparked row simply syncs. Either way the outcome is decided by
 *     the cloud, not by a regex over a log line.
 *
 * NOTHING HERE DELETES A QUEUE ROW. Resolved hides a row; the TestResult /
 * Comments / State survive and stay queryable, and the delta-sync reappearance
 * path can un-resolve it.
 */

/** SyncMaintenanceFlags keys. Values are opaque TEXT; never field data. */
const FLAG_CLOUD_EMITS_CODE = 'cloud_emits_rejection_code'
const FLAG_SWEEP_DONE = 'backlog_readjudication_v1'
const FLAG_CANARY = 'backlog_readjudication_canary'

const RESOLVE_REASON =
  'backlog re-adjudication — the cloud had already confirmed this target was removed; ' +
  'closed as terminal (row and value kept, un-resolves if the target reappears)'

// In-memory fast-paths. These NEVER stand in for the durable flags — they only
// avoid re-running a query whose answer we just learned in this process.
let sweepCompleteCache = false
let orphanSweepClearCache = false
let cloudEmitsCodeCache = false
// At most ONE canary release per process (see the CAPABILITY BOOTSTRAP note).
let canaryReleasedThisProcess = false
// The sweep is invoked from the 10 s push tick. While it is waiting on the cloud
// capability it would otherwise re-scan the parked rows every tick forever, so
// the scan is throttled. Nothing depends on the scan being prompt: the moment
// the capability flag flips, the very next tick past the throttle sweeps.
const SCAN_THROTTLE_MS = 60_000
let lastScanAt = 0

// ---------------------------------------------------------------------------
// Durable flag store
// ---------------------------------------------------------------------------

export function getSyncFlag(key: string): string | null {
  try {
    const row = db.prepare('SELECT Value FROM SyncMaintenanceFlags WHERE Key = ?').get(key) as
      | { Value: string | null }
      | undefined
    return row?.Value ?? null
  } catch {
    // Table missing on a very old DB — treat as "not set". Never throw: this
    // module is called from the push loop and must never break syncing.
    return null
  }
}

export function setSyncFlag(key: string, value: string): void {
  try {
    db.prepare(
      `INSERT INTO SyncMaintenanceFlags (Key, Value, UpdatedAt) VALUES (?, ?, datetime('now'))
       ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value, UpdatedAt = excluded.UpdatedAt`,
    ).run(key, value)
  } catch (e) {
    console.warn('[BacklogReAdjudication] flag write failed:', (e as Error)?.message || e)
  }
}

// ---------------------------------------------------------------------------
// The cloud-emits-`code` capability guard
// ---------------------------------------------------------------------------

/**
 * Record that the cloud answered a rejection with a machine-readable `code`.
 * Called from the push loop for ANY code (io_not_found, io_wrong_project,
 * version_conflict, …) — the PRESENCE of the field is the capability signal,
 * not its value.
 *
 * WHY THIS GATE EXISTS: against a PRE-`code` cloud a released row would be
 * re-rejected with the same bare `reason: 'IO not found'`, fall through the same
 * regex, and re-park via the OLD path — burning the one retry this row will ever
 * get and leaving it permanently marked, so a later cloud upgrade could never
 * re-adjudicate it. Releasing the backlog before we know the cloud can answer
 * properly converts a fixable backlog into an unfixable one.
 */
export function noteCloudEmitsRejectionCode(): void {
  if (cloudEmitsCodeCache) return
  cloudEmitsCodeCache = true
  if (getSyncFlag(FLAG_CLOUD_EMITS_CODE)) return
  setSyncFlag(FLAG_CLOUD_EMITS_CODE, new Date().toISOString())
  console.log(
    '[BacklogReAdjudication] cloud emits machine-readable rejection codes — backlog re-adjudication unlocked',
  )
}

/** True once a coded rejection has EVER been observed by this tool (durable). */
export function cloudEmitsRejectionCode(): boolean {
  if (cloudEmitsCodeCache) return true
  const seen = getSyncFlag(FLAG_CLOUD_EMITS_CODE) != null
  if (seen) cloudEmitsCodeCache = true
  return seen
}

// ---------------------------------------------------------------------------
// (a) Settled orphans → Resolved
// ---------------------------------------------------------------------------

/** Queues that carry an Orphaned column. E-stop/guided have none. */
const ORPHAN_QUEUES = ['PendingSyncs', 'L2PendingSyncs', 'DeviceBlockerPendingSyncs'] as const

/**
 * (a) Close out rows the cloud ALREADY judged: Orphaned=1 AND Resolved=0.
 * Pure bookkeeping on a settled conclusion — orphan() itself now marks Resolved,
 * so this only ever matches rows orphaned by the pre-2026-07-22 build.
 * Idempotent by construction: a row it touches stops matching.
 */
export function resolveSettledOrphans(): { resolved: number } {
  let resolved = 0
  const now = new Date().toISOString()
  for (const table of ORPHAN_QUEUES) {
    try {
      const info = db
        .prepare(
          `UPDATE ${table}
              SET Resolved = 1, ResolvedAt = ?, ResolvedReason = ?
            WHERE Orphaned = 1 AND Resolved = 0`,
        )
        .run(now, RESOLVE_REASON)
      if (info.changes > 0) {
        resolved += info.changes
        auditLog({
          type: 'sync.readjudicate',
          reason: 'settled orphans closed as terminal (Resolved)',
          detail: { table, rows: info.changes },
        })
      }
    } catch (e) {
      // Missing table/column on an old DB — skip it, never break the push loop.
      console.warn(`[BacklogReAdjudication] orphan sweep failed for ${table}:`, (e as Error)?.message || e)
    }
  }
  return { resolved }
}

// ---------------------------------------------------------------------------
// (b) Legacy parked "gone on cloud" rows → released ONCE for a real verdict
// ---------------------------------------------------------------------------

interface Candidate {
  id: number
  LastError: string | null
  CreatedAt: string | null
}

/**
 * Rows eligible for a ONE-TIME release. The ReAdjudicatedAt IS NULL predicate is
 * the durable at-most-once guard — not a heuristic, not an age window.
 *
 * Classification reuses queue-inspector.classify() verbatim. This is the ONE
 * place string-matching is still acceptable, because its output is not a verdict
 * — it only selects which rows get to ASK the cloud for a verdict. A false
 * positive here costs one extra push; it can never hide anything.
 */
function findReAdjudicationCandidates(): Candidate[] {
  const rows = db
    .prepare(
      `SELECT id, LastError, CreatedAt
         FROM PendingSyncs
        WHERE DeadLettered = 1 AND Orphaned = 0 AND Resolved = 0
          AND ReAdjudicatedAt IS NULL
        ORDER BY CreatedAt ASC, id ASC`,
    )
    .all() as Candidate[]
  return rows.filter((r) => classify(r.LastError).classification === 'gone_on_cloud')
}

/**
 * Release one row: clear the park AND stamp the marker in the SAME statement.
 * `AND ReAdjudicatedAt IS NULL` makes the write self-guarding, so a concurrent
 * or re-entered sweep can never release the same row twice, and an interrupt
 * mid-sweep leaves every already-released row correctly marked.
 *
 * The original LastError is journaled BEFORE it is cleared — the release wipes
 * it, and losing the only record of why a row was parked would make a wrong
 * re-adjudication undiagnosable.
 */
function releaseRow(row: Candidate): boolean {
  const info = db
    .prepare(
      `UPDATE PendingSyncs
          SET DeadLettered = 0, RetryCount = 0, LastError = NULL, ReAdjudicatedAt = ?
        WHERE id = ? AND ReAdjudicatedAt IS NULL AND DeadLettered = 1 AND Orphaned = 0 AND Resolved = 0`,
    )
    .run(new Date().toISOString(), row.id)
  if (info.changes === 0) return false
  auditLog({
    type: 'sync.readjudicate',
    reason: 'legacy parked row released once for a cloud verdict',
    detail: { queue: 'PendingSyncs', id: row.id, createdAt: row.CreatedAt, originalLastError: row.LastError },
  })
  return true
}

export interface ReAdjudicationResult {
  /** Rows closed by (a). */
  orphansResolved: number
  /** Rows released by (b) in this call. */
  released: number
  /** Why (b) did nothing, when it did nothing. */
  status: 'complete' | 'no_candidates' | 'canary_released' | 'awaiting_cloud_capability' | 'already_done'
}

/**
 * The orchestrator. Cheap to call on every push tick: once the sweep has
 * completed it early-outs on an in-memory boolean.
 *
 * CAPABILITY BOOTSTRAP (the chicken-and-egg). The `code` flag can only be set by
 * OBSERVING a coded rejection, which requires an ACTIVE row to be pushed. A tool
 * whose queue is entirely backlog has no active rows, so it would never learn the
 * cloud is capable and would never sweep — deadlock.
 *
 * Resolved with a CANARY: while the capability is unknown, release exactly ONE
 * row (the oldest candidate) and stop. Its next push is the probe.
 *   - New cloud → the rejection carries a `code` → the flag is set → the next
 *     tick releases the whole remaining backlog.
 *   - Old cloud → it re-parks exactly as before, permanently marked. Cost is one
 *     row's one extra retry, and re-parking restores the exact prior state.
 * At most one canary per PROCESS, and each canary row is permanently marked, so
 * a tool that keeps rebooting against an old cloud spends at most one distinct
 * row per boot — bounded, and it converges the moment the cloud is upgraded.
 */
export function runBacklogReAdjudication(): ReAdjudicationResult {
  if (sweepCompleteCache) {
    return { orphansResolved: 0, released: 0, status: 'already_done' }
  }
  if (getSyncFlag(FLAG_SWEEP_DONE)) {
    sweepCompleteCache = true
    return { orphansResolved: 0, released: 0, status: 'already_done' }
  }

  // Waiting on the cloud capability with this process's one canary already
  // spent: nothing can change until the capability flag flips, so skip the scan
  // entirely rather than walking the parked rows on every 10 s tick.
  if (canaryReleasedThisProcess && !cloudEmitsRejectionCode()) {
    return { orphansResolved: 0, released: 0, status: 'awaiting_cloud_capability' }
  }

  // (a) always — it needs no capability guard and is idempotent.
  let orphansResolved = 0
  if (!orphanSweepClearCache) {
    orphansResolved = resolveSettledOrphans().resolved
    if (orphansResolved === 0) orphanSweepClearCache = true
  }

  // Throttle the candidate scan. The only state that can un-block the sweep is
  // the durable capability flag, which is checked above for free.
  const nowMs = Date.now()
  if (lastScanAt !== 0 && nowMs - lastScanAt < SCAN_THROTTLE_MS) {
    return { orphansResolved, released: 0, status: 'awaiting_cloud_capability' }
  }
  lastScanAt = nowMs

  let candidates: Candidate[]
  try {
    candidates = findReAdjudicationCandidates()
  } catch (e) {
    console.warn('[BacklogReAdjudication] candidate scan failed:', (e as Error)?.message || e)
    return { orphansResolved, released: 0, status: 'awaiting_cloud_capability' }
  }

  if (candidates.length === 0) {
    // Nothing left to adjudicate. Only bank "done" once we KNOW the cloud is
    // capable — otherwise a tool that boots with an empty backlog would mark the
    // sweep complete and skip a backlog that arrives later against a new cloud.
    if (cloudEmitsRejectionCode()) {
      setSyncFlag(FLAG_SWEEP_DONE, new Date().toISOString())
      sweepCompleteCache = true
      return { orphansResolved, released: 0, status: 'complete' }
    }
    return { orphansResolved, released: 0, status: 'no_candidates' }
  }

  if (!cloudEmitsRejectionCode()) {
    if (canaryReleasedThisProcess) {
      return { orphansResolved, released: 0, status: 'awaiting_cloud_capability' }
    }
    const canary = candidates[0]
    canaryReleasedThisProcess = true
    const ok = releaseRow(canary)
    if (ok) {
      setSyncFlag(FLAG_CANARY, `${new Date().toISOString()} id=${canary.id}`)
      console.log(
        `[BacklogReAdjudication] cloud rejection-code capability unknown — released 1 canary row ` +
          `(PendingSyncs#${canary.id}) to probe it; ${candidates.length - 1} row(s) held back`,
      )
    }
    return { orphansResolved, released: ok ? 1 : 0, status: 'canary_released' }
  }

  // Capability confirmed — release the rest. Batched in one transaction so the
  // whole sweep either lands or leaves each row correctly marked; every write is
  // individually self-guarded, so an interrupt is safe regardless.
  let released = 0
  try {
    const run = db.transaction((rows: Candidate[]) => {
      for (const r of rows) if (releaseRow(r)) released++
    })
    run(candidates)
  } catch (e) {
    console.warn('[BacklogReAdjudication] release failed:', (e as Error)?.message || e)
    return { orphansResolved, released, status: 'awaiting_cloud_capability' }
  }

  setSyncFlag(FLAG_SWEEP_DONE, new Date().toISOString())
  sweepCompleteCache = true
  console.log(
    `[BacklogReAdjudication] released ${released} legacy parked row(s) for re-adjudication; ` +
      `${orphansResolved} settled orphan(s) closed. Sweep complete.`,
  )
  auditLog({
    type: 'sync.readjudicate',
    reason: 'one-time backlog re-adjudication sweep completed',
    detail: { released, orphansResolved },
  })
  return { orphansResolved, released, status: 'complete' }
}

/** Observability for tests + diagnostics. Never mutates. */
export function getReAdjudicationState(): {
  cloudEmitsCodeAt: string | null
  sweepCompletedAt: string | null
  canary: string | null
} {
  return {
    cloudEmitsCodeAt: getSyncFlag(FLAG_CLOUD_EMITS_CODE),
    sweepCompletedAt: getSyncFlag(FLAG_SWEEP_DONE),
    canary: getSyncFlag(FLAG_CANARY),
  }
}

/**
 * Reset the in-process caches. TEST-ONLY — production code has exactly one
 * database for the life of the process, but the suite swaps in-memory DBs.
 */
export function __resetReAdjudicationCachesForTests(): void {
  sweepCompleteCache = false
  orphanSweepClearCache = false
  cloudEmitsCodeCache = false
  canaryReleasedThisProcess = false
  lastScanAt = 0
}
