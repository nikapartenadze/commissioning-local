/**
 * Durable client-side FV/L2 cell outbox.
 *
 * The FV grid used to save cells fire-and-forget: it optimistically painted the
 * value, POSTed, and never checked the result. Any failed or in-flight POST was
 * lost silently — the cell showed "saved" until a reload re-read the DB and it
 * vanished ("some cells saved, some not, after reload").
 *
 * This module makes a cell edit durable and self-healing:
 *   1. Persist the edit to a durable store (localStorage) BEFORE the POST.
 *   2. POST with an explicit res.ok / body.success check and bounded retry with
 *      backoff for TRANSIENT failures (network, timeout, 5xx, 408, 429).
 *   3. Only remove the edit from the outbox once the server CONFIRMS it.
 *   4. On page load, replay whatever never confirmed.
 *
 * Pure logic with injected storage + fetch so it is testable without a DOM.
 * The server write itself is already synchronous + durable + audited
 * (app/api/l2/cell/route.ts); this closes the client-side gap.
 */

export interface L2Edit {
  deviceId: number
  columnId: number
  value: string | null
  updatedBy: string
  /** Monotonic tag for the edit; used to avoid clearing a newer edit that
   *  replaced this one while its POST was in flight. */
  ts: number
  /** Consecutive replay failures. Bounded so a permanently-broken edit (e.g. a
   *  stale local id after a pull, or a 400) can't loop forever on every load. */
  attempts?: number
}

export interface SaveResult {
  ok: boolean
  status?: number
  error?: string
  /** True if the edit was durably written to the outbox. False means the store
   *  itself failed (e.g. quota) — the edit is NOT recoverable via replay, so the
   *  caller must treat a !ok result as a hard, visible failure. */
  queued?: boolean
}

interface MinimalResponse {
  ok: boolean
  status: number
  json: () => Promise<any>
}

export interface OutboxDeps {
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void }
  fetchFn: (input: string, init?: any) => Promise<MinimalResponse>
  /** Injectable for tests. */
  now?: () => number
  /** Injectable for tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>
}

const OUTBOX_KEY = 'l2-cell-outbox-v1'
const ENDPOINT = '/api/l2/cell'
const MAX_ATTEMPTS = 4
// After this many failed REPLAY passes, evict the edit so it can't loop forever
// (a permanent 4xx or a local id invalidated by a pull). Eviction is logged
// loudly — the value survives in the server-side recovery audit for any write
// that ever reached the server; a never-reached edit is surfaced, not hidden.
const MAX_REPLAY_ATTEMPTS = 5

function cellKey(deviceId: number, columnId: number): string {
  return `${deviceId}:${columnId}`
}

function backoffMs(attempt: number): number {
  // 250ms, 500ms, 1000ms … capped. Transient localhost stalls clear quickly.
  return Math.min(250 * 2 ** (attempt - 1), 4000)
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function loadOutbox(storage: OutboxDeps['storage']): Record<string, L2Edit> {
  try {
    const raw = storage.getItem(OUTBOX_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persist(storage: OutboxDeps['storage'], map: Record<string, L2Edit>): boolean {
  try { storage.setItem(OUTBOX_KEY, JSON.stringify(map)); return true } catch { return false }
}

export function pendingCount(storage: OutboxDeps['storage']): number {
  return Object.keys(loadOutbox(storage)).length
}

export function getPendingKeys(storage: OutboxDeps['storage']): string[] {
  return Object.keys(loadOutbox(storage))
}

function enqueue(storage: OutboxDeps['storage'], edit: L2Edit): boolean {
  const map = loadOutbox(storage)
  map[cellKey(edit.deviceId, edit.columnId)] = edit
  return persist(storage, map)
}

/** Remove the edit ONLY if the outbox still holds this exact edit (same ts). A
 *  newer edit for the same cell may have replaced it while in flight — leave the
 *  newer one queued so it still gets flushed. */
function clearIfUnchanged(storage: OutboxDeps['storage'], edit: L2Edit): void {
  const map = loadOutbox(storage)
  const k = cellKey(edit.deviceId, edit.columnId)
  if (map[k] && map[k].ts === edit.ts) {
    delete map[k]
    persist(storage, map)
  }
}

function isPermanentClientError(status: number): boolean {
  // 4xx won't fix itself — except 408 (timeout) and 429 (rate limit), which are
  // worth retrying.
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

async function postWithRetry(edit: L2Edit, deps: OutboxDeps): Promise<SaveResult> {
  const sleep = deps.sleep ?? realSleep
  let lastError: string | undefined
  let lastStatus: number | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await deps.fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: edit.deviceId,
          columnId: edit.columnId,
          value: edit.value,
          updatedBy: edit.updatedBy,
        }),
      })
      lastStatus = res.status
      if (res.ok) {
        const body = await res.json().catch(() => ({}))
        if (body?.success !== false) return { ok: true, status: res.status }
        lastError = 'server reported success=false'
      } else {
        lastError = `HTTP ${res.status}`
        if (isPermanentClientError(res.status)) {
          return { ok: false, status: res.status, error: lastError }
        }
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt))
  }
  return { ok: false, status: lastStatus, error: lastError }
}

/**
 * Save one FV cell edit durably. Persists to the outbox first, then pushes with
 * retry. Returns ok:false (edit still queued) so the caller can flag the cell
 * as unsaved rather than silently showing a value that never persisted.
 */
export async function saveL2Cell(edit: L2Edit, deps: OutboxDeps): Promise<SaveResult> {
  const queued = enqueue(deps.storage, edit)
  if (!queued) {
    // Durable store failed (quota/serialise). A reload can NOT replay this — do
    // not let it be silent. The POST is still attempted below; if it also fails
    // the caller sees ok:false + queued:false and must surface it hard.
    console.error('[l2-outbox] FAILED to persist edit to durable outbox — it will NOT survive a reload:', { deviceId: edit.deviceId, columnId: edit.columnId })
  }
  const result = await postWithRetry(edit, deps)
  if (result.ok) clearIfUnchanged(deps.storage, edit)
  return { ...result, queued }
}

/**
 * Replay every queued edit — call on page load and on reconnect. Clears the ones
 * the server now accepts; keeps the rest so they are never lost.
 */
export async function replayL2Outbox(deps: OutboxDeps): Promise<{ replayed: number; failed: number; evicted: number; remaining: number }> {
  const entries = Object.values(loadOutbox(deps.storage))
  let replayed = 0
  let failed = 0
  let evicted = 0
  for (const edit of entries) {
    const r = await postWithRetry(edit, deps)
    if (r.ok) { clearIfUnchanged(deps.storage, edit); replayed++; continue }
    failed++
    // Bump the replay-failure count; evict once it can no longer plausibly
    // succeed (permanent 4xx, or a local id invalidated by a pull) so it does
    // not loop on every load. Evicting is loud — never silent.
    const map = loadOutbox(deps.storage)
    const k = cellKey(edit.deviceId, edit.columnId)
    const cur = map[k]
    if (cur && cur.ts === edit.ts) {
      const attempts = (cur.attempts ?? 0) + 1
      if (attempts >= MAX_REPLAY_ATTEMPTS) {
        delete map[k]
        evicted++
        console.error(`[l2-outbox] EVICTING FV edit after ${attempts} failed replays — it never reached the server. Last error: ${r.error ?? r.status}`, { deviceId: edit.deviceId, columnId: edit.columnId, value: edit.value })
      } else {
        map[k] = { ...cur, attempts }
      }
      persist(deps.storage, map)
    }
  }
  return { replayed, failed, evicted, remaining: pendingCount(deps.storage) }
}
