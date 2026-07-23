/**
 * Retry-REAL — make the Sync Center's "Retry" actually re-attempt an upload and
 * report the true outcome.
 *
 * WHY THIS EXISTS: `retry()` (queue-inspector) only RESETS the local queue-row
 * flags — un-parks the row, clears RetryCount/LastError. That alone re-sends
 * nothing; the actual upload is the background drain (auto-sync's ~10s tick →
 * POST {cloud}/api/sync/update). So on a dead link the old "Re-queued for sync"
 * toast was a lie: nothing new happened. This kicks ONE real drain now (the very
 * same `kickPush` entrypoint the cloud `force-sync` command uses) and then
 * OBSERVES the queue rows to report what genuinely happened — bounded by a
 * timeout so a slow/stopped cloud can never hang the request.
 *
 * How the outcome is observed (no push internals are reimplemented — the real
 * drain does the work and records its verdict on each queue row):
 *   - retry() left every candidate row with LastError = NULL.
 *   - The drain DELETES a row it delivered, and writes a non-null LastError on a
 *     row it failed (`HTTP 403`, `offline`, `HTTP 500 (network-level…)`, …), or
 *     ORPHANS (Resolved=1) a row whose cloud target was removed.
 *   - So after the drain: absent+not-resolved = delivered; absent+resolved =
 *     removed-on-cloud; present+LastError = failed-this-pass; present+NULL =
 *     not-yet-attempted (budget expired / drain still working).
 *
 * DATA SAFETY: this module never writes any queue or data table. It only calls
 * kickPush() and READS via snapshotRefs/listQueue.
 */
import { snapshotRefs, listQueue, type QueueKind, type QueueItem } from '@/lib/sync/queue-inspector'
import { getAutoSyncService } from '@/lib/cloud/auto-sync'

export type RetryPushOutcome = 'sent' | 'still_failing' | 'no_connection' | 'still_trying'

export interface RetryPushResult {
  /** Rows that reached the cloud (deleted from the queue on success). */
  pushed: number
  /** Rows that did NOT land this attempt (failed / removed-on-cloud / still going). */
  failed: number
  outcome: RetryPushOutcome
  /** The cloud's HTTP status when a live response was observed (e.g. 403). */
  httpStatus?: number
  /** Honest, operator-facing summary of what actually happened. */
  message: string
}

export interface RetryPushOptions {
  /** Total time to wait for the drain to adjudicate the rows. Default 20s. */
  budgetMs?: number
  /** Poll cadence while waiting. Default 750ms. */
  intervalMs?: number
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>
}

type Ref = { kind: QueueKind; id: number }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const key = (r: { kind: QueueKind; id: number }) => `${r.kind}:${r.id}`

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Extract an HTTP status a queue row's LastError carries (e.g. 'HTTP 403', 'HTTP 404 — removed'). */
export function parseHttpStatus(lastError: string | null | undefined): number | undefined {
  if (!lastError) return undefined
  const m = /\bHTTP (\d{3})\b/.exec(lastError)
  return m ? Number(m[1]) : undefined
}

const NETWORKISH =
  /timeout|econn|refused|fetch failed|failed to fetch|offline|socket|network|no remote|aborted|dns|enotfound|unreachable/i

function hasError(it: QueueItem): boolean {
  return it.lastError != null && String(it.lastError).trim() !== ''
}

function presentMap(items: QueueItem[]): Map<string, QueueItem> {
  const m = new Map<string, QueueItem>()
  for (const it of items) m.set(key(it), it)
  return m
}

/**
 * Settled = every candidate row has been adjudicated by the drain: it is either
 * GONE (delivered / removed-on-cloud) or carries a fresh LastError. A row still
 * present with a NULL LastError means the drain has not reached it yet.
 */
function isSettled(before: Ref[], after: QueueItem[]): boolean {
  const am = presentMap(after)
  return before.every((r) => {
    const it = am.get(key(r))
    return !it || hasError(it)
  })
}

function statusDetail(s: number): string {
  switch (s) {
    case 401: return 'not authorized — check the sync key'
    case 403: return 'key mismatch'
    case 404:
    case 410: return 'the record no longer exists on the cloud'
    case 409: return 'version conflict'
    case 400:
    case 422: return 'the cloud rejected this value'
    default: return ''
  }
}

/**
 * Turn the observed before/after queue state into an honest result. Pure — no
 * I/O — so it is unit-testable in isolation. `resolvedNow` is the set of refs
 * that became Resolved (orphaned: their cloud target was removed) this pass;
 * such a row leaves the active queue but was NOT delivered, so it must never be
 * counted as "sent".
 */
export function deriveRetryResult(
  before: Ref[],
  after: QueueItem[],
  resolvedNow: Set<string>,
): RetryPushResult {
  const am = presentMap(after)
  let pushed = 0
  let removedOnCloud = 0
  let unattended = 0
  const failedItems: QueueItem[] = []

  for (const r of before) {
    const it = am.get(key(r))
    if (!it) {
      if (resolvedNow.has(key(r))) removedOnCloud++ // orphaned — gone on cloud, not sent
      else pushed++ // delivered / cleared
      continue
    }
    if (hasError(it)) failedItems.push(it)
    else unattended++
  }
  const failed = before.length - pushed

  // 1) A definite client-side rejection (4xx, non-429) is the most actionable —
  //    surface it with its status so the operator can act (fix key, discard…).
  if (failedItems.length > 0) {
    const statuses = failedItems
      .map((it) => parseHttpStatus(it.lastError))
      .filter((n): n is number => n != null)
    const clientReject = statuses.find((s) => s >= 400 && s < 500 && s !== 429)
    if (clientReject != null) {
      return {
        pushed,
        failed,
        outcome: 'still_failing',
        httpStatus: clientReject,
        message: stillFailingMessage(failed, clientReject),
      }
    }
    // 2) A server error / throttle / offline reason → couldn't reach a working cloud.
    const serverStatus = statuses.find((s) => s >= 500 || s === 429)
    const anyNetworkish = failedItems.some((it) => NETWORKISH.test(it.lastError || ''))
    if (serverStatus != null || anyNetworkish) {
      return {
        pushed,
        failed,
        outcome: 'no_connection',
        ...(serverStatus != null ? { httpStatus: serverStatus } : {}),
        message: noConnectionMessage(serverStatus),
      }
    }
    // 3) Failed with a reason we can't map to a status or a network cause — honest
    //    "the cloud refused it" without inventing a status.
    return {
      pushed,
      failed,
      outcome: 'still_failing',
      message: `The cloud wouldn't accept ${failed} of these. Check the value, or Discard if no longer needed.`,
    }
  }

  // 4) No live failures, but some rows were removed on the cloud — not delivered.
  if (removedOnCloud > 0) {
    return {
      pushed,
      failed,
      outcome: 'still_failing',
      message: removedOnCloudMessage(pushed, removedOnCloud),
    }
  }

  // 5) Rows not yet adjudicated within the budget (slow cloud, big queue, a drain
  //    already in flight, or no sync service running) — the sync keeps going.
  if (unattended > 0) {
    return { pushed, failed, outcome: 'still_trying', message: stillTryingMessage(pushed) }
  }

  // 6) Everything left the queue and nothing was orphaned → genuinely delivered.
  return {
    pushed,
    failed,
    outcome: 'sent',
    message: `Sent ${pushed} result${pushed === 1 ? '' : 's'} ✓`,
  }
}

function stillFailingMessage(failed: number, status: number): string {
  const detail = statusDetail(status)
  if (status === 401 || status === 403) {
    return `Still can't reach the cloud (HTTP ${status}${detail ? ` — ${detail}` : ''}).`
  }
  if (status === 404 || status === 410) {
    return `The cloud no longer has ${failed} of these (HTTP ${status}). Discard them if they're no longer needed.`
  }
  return `The cloud rejected ${failed} (HTTP ${status}${detail ? ` — ${detail}` : ''}).`
}

function noConnectionMessage(status?: number): string {
  return status != null
    ? `Cloud is unavailable (HTTP ${status}) — will keep trying in the background.`
    : 'Cloud unreachable — will keep trying in the background.'
}

function removedOnCloudMessage(pushed: number, removed: number): string {
  const sent = pushed > 0 ? `Sent ${pushed}. ` : ''
  return `${sent}${removed} ${removed === 1 ? 'was' : 'were'} removed on the cloud — nothing to send ${removed === 1 ? 'it' : 'them'} to. Discard if no longer needed.`
}

function stillTryingMessage(pushed: number): string {
  return pushed > 0
    ? `Sent ${pushed} so far — the rest are still sending in the background.`
    : "The sync is still running — it'll keep going in the background."
}

/**
 * Kick ONE real drain for the just-retried rows and report the true outcome,
 * bounded by a timeout. Reuses the cloud force-sync entrypoint
 * (AutoSyncService.kickPush) — the same code path as the periodic tick — then
 * observes the queue rows to see what landed.
 */
export async function performRetryPush(refs: Ref[], opts: RetryPushOptions = {}): Promise<RetryPushResult> {
  const budgetMs = opts.budgetMs ?? envInt('SYNC_RETRY_PUSH_BUDGET_MS', 20_000)
  const intervalMs = opts.intervalMs ?? envInt('SYNC_RETRY_PUSH_POLL_MS', 750)
  const sleep = opts.sleep ?? defaultSleep

  // Only rows that actually exist post-reset are candidates.
  const before: Ref[] = snapshotRefs(refs).map((i) => ({ kind: i.kind, id: i.id }))
  if (before.length === 0) {
    return { pushed: 0, failed: 0, outcome: 'still_trying', message: 'Nothing to send — the selected rows are no longer queued.' }
  }

  // Kick the real background drain (fire-and-forget by design — it reports
  // through the queue rows, which we read below). If the sync service isn't
  // running we can't force a drain; fall straight through to an honest
  // "still trying" rather than blocking on a poll that can never settle.
  let kicked = false
  try {
    const svc = getAutoSyncService()
    if (svc) {
      svc.kickPush()
      kicked = true
    }
  } catch {
    /* observe/derive below */
  }

  let after = snapshotRefs(refs)
  if (kicked) {
    const deadline = Date.now() + budgetMs
    // Poll until every candidate is adjudicated or the budget expires. The first
    // check is BEFORE any sleep, so a fast drain (or a synchronous test kick)
    // returns immediately.
    while (!isSettled(before, after) && Date.now() < deadline) {
      await sleep(intervalMs)
      after = snapshotRefs(refs)
    }
  }

  // Rows that vanished may have been DELETED (delivered) or ORPHANED (Resolved=1,
  // removed on cloud). Resolved rows are excluded from snapshotRefs, so ask for
  // them by name to tell the two apart — a removal must not read as "sent".
  const resolvedNow = new Set(listQueue({ status: 'resolved' }).items.map(key))
  return deriveRetryResult(before, after, resolvedNow)
}
