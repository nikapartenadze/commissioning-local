/**
 * Shared "simple outbox drain" for subsystem-scoped pending-sync queues that
 * all follow the same shape: select-oldest-N, dedupe-by-identity, per-row POST,
 * and the Batch-1 hardened retry-cap classification.
 *
 * This exists because three near-identical drains had DRIFTED apart, and one
 * of them (the e-stop drain) shipped a transient-strike bug that the others had
 * already fixed. Extracting the loop once keeps the strike-vs-no-strike-vs-park
 * decision in a single place so it can never diverge again.
 *
 * The retry-cap contract (identical to the IO / L2 / device-blocker drains):
 *  - fetch threw (offline / DNS / timeout)  → keep row, NO strike, STOP batch
 *  - isNetworkLevelFailure(status) (429 / ≥500 / 401)
 *                                            → note error, NO strike, STOP batch
 *  - genuine cloud verdict (permanent 4xx)   → burn ONE strike toward the cap
 *  - RetryCount >= cap                        → PARK (DeadLettered=1), audit,
 *                                               keep the row for recovery
 *  - resp.ok                                  → delete ALL rows for the identity
 *
 * Queue-specific behaviour (identity, dedupe rule, endpoint, body, park text)
 * is injected via the options so each caller keeps its exact semantics.
 */
import type { Database } from 'better-sqlite3'
import { auditLog } from '@/lib/logging/recovery-log'
import { isNetworkLevelFailure } from '@/lib/cloud/sync-failure-classification'

/** Every simple queue row carries at least these columns. */
export interface SimpleQueueRow {
  id: number
  SubsystemId: number
  RetryCount: number
}

export interface DrainSimpleQueueOptions<Row extends SimpleQueueRow> {
  db: Database
  /** SQLite table backing the queue (e.g. 'EStopCheckPendingSyncs'). */
  tableName: string
  /** Strikes before a row is parked (DeadLettered=1) instead of retried. */
  retryCap: number
  /** Cloud base URL and API key for the POST. */
  remoteUrl: string
  apiPassword: string | undefined
  /** Cloud endpoint path, appended to remoteUrl (e.g. '/api/sync/estop-checks'). */
  endpoint: string
  /** Identity key used to collapse duplicate pending rows for the same entity. */
  dedupeKey: (row: Row) => string
  /**
   * Given two pending rows with the same identity, return true when `candidate`
   * should REPLACE the already-kept `existing` row (the other is dropped as
   * stale). Encodes each queue's last-write-wins rule, e.g.
   *  - e-stop:  candidate.Version < existing.Version  (keep the lowest/base version)
   *  - guided:  candidate.id > existing.id            (keep the newest write)
   */
  preferReplacement: (candidate: Row, existing: Row) => boolean
  /** Build the POST body for the winning row (may read live tables). */
  buildBody: (row: Row) => unknown
  /** Delete ALL pending rows sharing this row's identity — called on success. */
  deleteRowsForIdentity: (row: Row) => void
  /** Park-at-cap details, kept queue-specific so audit/log text stays exact. */
  park: {
    /** COALESCE fallback written to LastError if none was recorded yet. */
    defaultError: string
    /** auditLog reason for the sync.push.park entry. */
    auditReason: string
    /** auditLog detail payload for the parked row. */
    auditDetail: (row: Row) => Record<string, unknown>
    /** console.warn message for the parked row. */
    logMessage: (row: Row) => string
  }
}

/**
 * Drain one simple pending-sync queue. Behaviour-preserving extraction of the
 * shared loop shape — see the module doc for the exact retry-cap contract.
 */
export async function drainSimpleQueue<Row extends SimpleQueueRow>(
  opts: DrainSimpleQueueOptions<Row>,
): Promise<void> {
  const { db, tableName, retryCap, remoteUrl, apiPassword, endpoint } = opts

  const pending = db.prepare(
    `SELECT * FROM ${tableName} WHERE DeadLettered = 0 ORDER BY CreatedAt ASC LIMIT 50`,
  ).all() as Row[]
  if (pending.length === 0) return

  // Dedupe per identity, keeping the row each queue prefers and dropping the
  // rest as stale (deleted from the queue so they can't re-drive the loop).
  const byKey = new Map<string, Row>()
  const stale: number[] = []
  for (const p of pending) {
    const key = opts.dedupeKey(p)
    const existing = byKey.get(key)
    if (!existing) byKey.set(key, p)
    else if (opts.preferReplacement(p, existing)) { stale.push(existing.id); byKey.set(key, p) }
    else stale.push(p.id)
  }
  if (stale.length > 0) {
    const ph = stale.map(() => '?').join(',')
    try { db.prepare(`DELETE FROM ${tableName} WHERE id IN (${ph})`).run(...stale) } catch { /* best-effort */ }
  }

  const bumpRetry = db.prepare(
    `UPDATE ${tableName} SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?`,
  )
  const noteError = db.prepare(
    `UPDATE ${tableName} SET LastError = ? WHERE id = ?`,
  )

  for (const p of Array.from(byKey.values())) {
    if (p.RetryCount >= retryCap) {
      // PARK, don't DELETE — the queue's data survives (DeadLettered=1), out of
      // the active loop, and is audited for attention/recovery (the MCM11
      // silent-loss class deleted at the cap and left zero trace).
      try {
        db.prepare(
          `UPDATE ${tableName} SET DeadLettered = 1, LastError = COALESCE(LastError, ?) WHERE id = ?`,
        ).run(opts.park.defaultError, p.id)
      } catch { /* best-effort */ }
      try {
        auditLog({
          type: 'sync.push.park',
          subsystemId: p.SubsystemId,
          reason: opts.park.auditReason,
          detail: opts.park.auditDetail(p),
        })
      } catch { /* best-effort */ }
      console.warn(opts.park.logMessage(p))
      continue
    }

    let resp: globalThis.Response
    try {
      resp = await fetch(`${remoteUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
        body: JSON.stringify(opts.buildBody(p)),
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      // Offline / timeout — keep the row, no strike (next cycle retries).
      break
    }
    if (resp.ok) {
      try { opts.deleteRowsForIdentity(p) } catch { /* best-effort */ }
    } else if (isNetworkLevelFailure({ httpStatus: resp.status })) {
      // 429 / ≥500 / 401 — the cloud never ruled on this row. Do NOT burn a
      // retry-cap strike (the TPA8/MCM08 premature-park class): record the
      // reason and stop the batch — every later row would fail the same way and
      // each costs up to a 15 s timeout. Mirrors the IO / L2 / device-blocker drains.
      try { noteError.run(`HTTP ${resp.status} (network-level, no strike)`, p.id) } catch { /* best-effort */ }
      break
    } else {
      // Genuine cloud verdict (permanent 4xx) — burn a strike toward the cap.
      try { bumpRetry.run(`HTTP ${resp.status}`, p.id) } catch { /* best-effort */ }
    }
  }
}
