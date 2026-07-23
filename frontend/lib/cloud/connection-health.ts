/**
 * Cloud Connection Health — the MEASURED signal behind the Sync Center banner.
 *
 * The problem this solves (observed 2026-07): a tablet whose cloud link is
 * broken shows its queue as "Sending… temporary network issue…" for 24 HOURS
 * and the compare tab spins forever, because the tool makes the operator INFER
 * the diagnosis. The tool actually KNOWS: the last HTTP status it got, the last
 * time it truly reached the cloud, its cloud URL + key, and whether the SSE
 * stream authenticates. This module turns those known facts into one honest
 * verdict — including the deterministic 403 case (the tablet's apiPassword
 * doesn't match the project key), which will NEVER self-heal until a human
 * fixes the key, so silent forever-retry is exactly the wrong UX.
 *
 * REUSE, not a parallel store. The measured inputs come from what already
 * exists:
 *   - The cloud SSE client (lib/cloud/cloud-sse-client.ts) already tracks a live
 *     authenticated stream and, crucially, a distinct `auth-failed` state for
 *     HTTP 401/403 (added in F15). That is the strongest, real-time "the key is
 *     rejected" signal in the codebase and we treat it as decisive.
 *   - The heartbeat (lib/heartbeat/heartbeat-service.ts) is the existing regular
 *     authenticated round-trip. It already computes `resp.status` on every tick
 *     and threw it away; it now feeds recordCloud*() below (a few lines) so the
 *     passive signal carries a REAL last-success time + last HTTP status for all
 *     five states, refreshed every ~10s. No new timer, no new network call.
 *   - configService (lib/config/config-service.ts) supplies the cloud URL
 *     (EMBEDDED_REMOTE_URL / CLOUD_URL_OVERRIDE) and apiPassword.
 *   - The SQLite queue tables supply waitingCount (DeadLettered = 0 rows).
 *
 * The "Test connection" button drives probeCloudNow(): ONE live authenticated
 * round-trip, hard-capped by an AbortController so it can never hang.
 *
 * Everything that decides a state is a PURE function (classifyContact,
 * deriveConnectionHealth, runProbe) so each state is unit-tested from its
 * inputs and `unknown` can be proven to never masquerade as `connected`.
 */

import { configService, EMBEDDED_REMOTE_URL } from '@/lib/config'
import type { SseConnectionState } from '@/lib/cloud/cloud-sse-client'

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * A recorded success older than this is no longer "connected NOW" — absence of
 * a fresh success is not proof of health. 90s comfortably covers the ~10s
 * heartbeat cadence plus a couple of missed ticks without flapping to amber on
 * a single blip.
 */
export const CONNECTION_FRESHNESS_MS = 90_000

/** Hard cap on the live "Test connection" probe. It ALWAYS resolves by this. */
export const PROBE_TIMEOUT_MS = 8_000

/** Lightweight authenticated endpoint the probe hits (matches isCloudAvailable). */
export const PROBE_PATH = '/api/sync/health'

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConnectionHealthState =
  | 'connected' // a successful cloud contact within the freshness window
  | 'unreachable' // network / timeout / refused / DNS — will retry itself
  | 'auth_error' // 401/403 — key/auth mismatch; needs a human, never self-heals
  | 'server_error' // 5xx (and other non-2xx server responses) — wait it out
  | 'unknown' // no attempt yet / no data — NOT connected (absence ≠ health)

export interface ConnectionHealth {
  state: ConnectionHealthState
  /** ISO of the last PROVEN successful cloud contact, or null if never. */
  lastSuccessAt: string | null
  /** Detail of the most recent failure, or null when connected/unknown. */
  lastError: { httpStatus?: number; message?: string } | null
  /** The cloud URL this tablet is configured to talk to. */
  cloudUrl: string
  /** Active queue rows (DeadLettered = 0) still owed to the cloud. */
  waitingCount: number
}

/** One measured cloud contact. `http`/`network` are always failures here. */
export type ContactKind = 'success' | 'http' | 'network'
export interface CloudContact {
  /** epoch ms */
  at: number
  kind: ContactKind
  /** present on kind === 'http' */
  httpStatus?: number
  message?: string
}

// ─── The one measured store (globalThis-guarded singleton) ──────────────────
// Mirrors how cloud-sse-client keeps its singleton on globalThis so a duplicate
// module instance (HMR / re-import) can never split the store between the
// heartbeat writer and the route reader — they run in the same Express process.

interface HealthStore {
  last: CloudContact | null // most recent contact of ANY kind
  lastSuccess: CloudContact | null // most recent success
}

const globalForHealth = globalThis as unknown as { __cloudConnectionHealth?: HealthStore }

function store(): HealthStore {
  if (!globalForHealth.__cloudConnectionHealth) {
    globalForHealth.__cloudConnectionHealth = { last: null, lastSuccess: null }
  }
  return globalForHealth.__cloudConnectionHealth
}

/** Record any measured contact. Never throws (safe to call from a hot loop). */
export function recordCloudContact(contact: CloudContact): void {
  try {
    const s = store()
    s.last = contact
    if (contact.kind === 'success') s.lastSuccess = contact
  } catch {
    /* recording health must never break the caller */
  }
}

export function recordCloudSuccess(at: number = Date.now()): void {
  recordCloudContact({ at, kind: 'success' })
}

export function recordCloudHttpFailure(httpStatus: number, message?: string, at: number = Date.now()): void {
  recordCloudContact(
    message === undefined
      ? { at, kind: 'http', httpStatus }
      : { at, kind: 'http', httpStatus, message },
  )
}

export function recordCloudNetworkFailure(message?: string, at: number = Date.now()): void {
  recordCloudContact(
    message === undefined ? { at, kind: 'network' } : { at, kind: 'network', message },
  )
}

/** Read the recorded contacts (diagnostics / tests). */
export function getRecordedContacts(): HealthStore {
  const s = store()
  return { last: s.last, lastSuccess: s.lastSuccess }
}

/** Test-only: clear the store between cases. */
export function _resetConnectionHealthStore(): void {
  globalForHealth.__cloudConnectionHealth = { last: null, lastSuccess: null }
}

// ─── Pure classification ────────────────────────────────────────────────────

/**
 * Map ONE contact to a state, ignoring age (freshness is applied by the
 * caller — a success expires, a failure persists until something changes).
 */
export function classifyContact(contact: CloudContact): ConnectionHealthState {
  if (contact.kind === 'success') return 'connected'
  if (contact.kind === 'network') return 'unreachable'
  // kind === 'http' — a response arrived but was not OK.
  const s = contact.httpStatus
  if (s === 401 || s === 403) return 'auth_error'
  if (s !== undefined && s >= 500) return 'server_error'
  // 429 (throttle) and any other non-2xx: the server answered but refused/erred.
  // Bucket as server_error (advice = wait); the real status rides in lastError.
  return 'server_error'
}

/** Snapshot of the SSE client's live state, or null when it isn't running. */
export interface SseSnapshot {
  state: SseConnectionState
  /** epoch ms of the last SSE event (incl. keep-alives), or null. */
  lastEventAt: number | null
}

export interface HealthInputs {
  now: number
  cloudUrl: string
  waitingCount: number
  /** most recent measured contact (heartbeat or probe) */
  contact: CloudContact | null
  /** most recent measured SUCCESS */
  lastSuccess: CloudContact | null
  sse: SseSnapshot | null
  freshnessMs: number
}

function detailFrom(contact: CloudContact | null): { httpStatus?: number; message?: string } | null {
  if (!contact || contact.kind === 'success') return null
  if (contact.httpStatus !== undefined && contact.message !== undefined) {
    return { httpStatus: contact.httpStatus, message: contact.message }
  }
  if (contact.httpStatus !== undefined) return { httpStatus: contact.httpStatus }
  if (contact.message !== undefined) return { message: contact.message }
  return { message: contact.kind === 'network' ? 'Network error' : 'Cloud error' }
}

/**
 * The state machine. Precedence is chosen so we NEVER hide a rejected key and
 * NEVER report health from absence:
 *
 *   0. SSE `auth-failed` → auth_error. A live stream the cloud rejected is the
 *      safest, strongest 401/403 signal; it wins even over a fresh probe success
 *      (a public health endpoint answering 200 does NOT prove the key works).
 *   1. Most recent measured contact:
 *        - success & fresh              → connected
 *        - success but stale            → fall through (stale success ≠ connected)
 *        - failure & SSE is connected   → connected (the link recovered)
 *        - failure                      → that failure's state (auth/unreachable/server)
 *   2. Live SSE fallback when there's no usable contact:
 *        connected → connected · reconnecting → unreachable · else → unknown
 *   3. Nothing measured, no stream → unknown.
 */
export function deriveConnectionHealth(inp: HealthInputs): ConnectionHealth {
  const { now, cloudUrl, waitingCount, contact, lastSuccess, sse, freshnessMs } = inp
  const fresh = (at: number | null | undefined): boolean => at != null && now - at <= freshnessMs

  // Best-known success timestamp, independent of the current verdict.
  let successMs: number | null = lastSuccess ? lastSuccess.at : null
  if (sse?.state === 'connected') {
    const sseSuccess = sse.lastEventAt ?? now
    successMs = successMs == null ? sseSuccess : Math.max(successMs, sseSuccess)
  }

  const build = (state: ConnectionHealthState, lastError: { httpStatus?: number; message?: string } | null): ConnectionHealth => {
    let sMs = successMs
    if (state === 'connected' && sMs == null) sMs = now
    return {
      state,
      lastSuccessAt: sMs == null ? null : new Date(sMs).toISOString(),
      lastError: state === 'connected' || state === 'unknown' ? null : lastError,
      cloudUrl,
      waitingCount,
    }
  }

  // 0. Live auth rejection is decisive.
  if (sse?.state === 'auth-failed') {
    const fromContact = contact && classifyContact(contact) === 'auth_error' ? detailFrom(contact) : null
    return build('auth_error', fromContact ?? { message: 'The cloud rejected this tablet’s API key' })
  }

  // 1. Most recent measured contact.
  if (contact) {
    const cls = classifyContact(contact)
    if (cls === 'connected') {
      if (fresh(contact.at)) return build('connected', null)
      // stale success — fall through to the live SSE fallback below.
    } else {
      // A failure. If the stream is up right now, the link recovered.
      if (sse?.state === 'connected') return build('connected', null)
      return build(cls, detailFrom(contact))
    }
  }

  // 2. No usable contact — lean on the live stream.
  if (sse) {
    if (sse.state === 'connected') return build('connected', null)
    if (sse.state === 'reconnecting') {
      return build('unreachable', detailFrom(contact) ?? { message: 'Lost the connection to the cloud' })
    }
    // 'connecting' | 'disconnected' — we genuinely don't know yet.
    return build('unknown', null)
  }

  // 3. Nothing measured, no stream.
  return build('unknown', null)
}

// ─── Live gatherers (impure; server-only) ───────────────────────────────────

/**
 * Sum active queue rows (DeadLettered = 0) still owed to the cloud. Matches the
 * `totalPendingCount` in /api/cloud/status so the banner never disagrees with
 * the Sync Center dialog. Per-query try/catch tolerates a missing table on an
 * older DB (mirrors queue-inspector), so a fresh install never throws here.
 */
async function countWaiting(): Promise<number> {
  try {
    const { db } = await import('@/lib/db-sqlite')
    const safeCount = (sql: string): number => {
      try {
        return (db.prepare(sql).get() as { c: number }).c
      } catch {
        return 0
      }
    }
    const io = safeCount('SELECT COUNT(*) AS c FROM PendingSyncs WHERE DeadLettered = 0')
    const l2 = safeCount('SELECT COUNT(*) AS c FROM L2PendingSyncs WHERE DeadLettered = 0')
    const cr = safeCount("SELECT COUNT(*) AS c FROM ChangeRequests WHERE Status = 'pending' AND CloudId IS NULL")
    return io + l2 + cr
  } catch {
    return 0
  }
}

async function readSseSnapshot(): Promise<SseSnapshot | null> {
  try {
    const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
    const client = getCloudSseClient()
    if (!client) return null
    return {
      state: client.connectionState,
      lastEventAt: client.lastEventAt ? client.lastEventAt.getTime() : null,
    }
  } catch {
    return null
  }
}

async function resolveCloudUrl(): Promise<string> {
  try {
    const cfg = await configService.getConfig()
    return cfg.remoteUrl || EMBEDDED_REMOTE_URL
  } catch {
    return EMBEDDED_REMOTE_URL
  }
}

/**
 * The passive health object the GET route returns. Reads the measured store +
 * live SSE state + queue counts and runs the pure state machine over them.
 */
export async function getConnectionHealth(): Promise<ConnectionHealth> {
  const [cloudUrl, waitingCount, sse] = await Promise.all([
    resolveCloudUrl(),
    countWaiting(),
    readSseSnapshot(),
  ])
  const s = store()
  return deriveConnectionHealth({
    now: Date.now(),
    cloudUrl,
    waitingCount,
    contact: s.last,
    lastSuccess: s.lastSuccess,
    sse,
    freshnessMs: CONNECTION_FRESHNESS_MS,
  })
}

// ─── The live probe ─────────────────────────────────────────────────────────

export interface ProbeResult {
  contact: CloudContact
  state: ConnectionHealthState
}

/**
 * ONE authenticated round-trip to the cloud, hard-capped by an AbortController.
 * PURE-ish: no config/db/store access, `fetch` and the clock are injectable, so
 * the timeout behaviour is unit-testable without a network. It ALWAYS resolves
 * within `timeoutMs` — a hung fetch is aborted and reported as unreachable, so
 * the "Test connection" button can never spin forever.
 */
export async function runProbe(opts: {
  url: string
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`probe timed out after ${timeoutMs}ms`, 'TimeoutError'))
  }, timeoutMs)

  let contact: CloudContact
  try {
    const resp = await doFetch(`${opts.url.replace(/\/$/, '')}${PROBE_PATH}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': opts.apiKey },
      signal: controller.signal,
    })
    contact = resp.ok
      ? { at: now(), kind: 'success' }
      : { at: now(), kind: 'http', httpStatus: resp.status, message: `HTTP ${resp.status}` }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const message =
      name === 'TimeoutError'
        ? `timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err)
    contact = { at: now(), kind: 'network', message }
  } finally {
    clearTimeout(timer)
  }

  return { contact, state: classifyContact(contact) }
}

/**
 * Run a live probe NOW and fold its result into the measured store, so the very
 * next getConnectionHealth() reflects it. Reads cloud URL + key from config.
 * Never throws.
 */
export async function probeCloudNow(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<void> {
  let url = EMBEDDED_REMOTE_URL
  let apiKey = ''
  try {
    const cfg = await configService.getConfig()
    url = cfg.remoteUrl || EMBEDDED_REMOTE_URL
    apiKey = cfg.apiPassword || ''
  } catch {
    /* fall back to the embedded URL with no key */
  }
  if (!url) {
    recordCloudNetworkFailure('no remote URL configured')
    return
  }
  try {
    const { contact } = await runProbe({ url, apiKey, timeoutMs })
    recordCloudContact(contact)
  } catch (err) {
    // runProbe already swallows fetch errors; this is belt-and-braces.
    recordCloudNetworkFailure(err instanceof Error ? err.message : String(err))
  }
}
