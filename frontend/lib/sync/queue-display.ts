/**
 * Sync Center — PURE, CLIENT-SAFE display/triage logic (no I/O, no db).
 *
 * The SINGLE SOURCE OF TRUTH for how a queue row's raw state (status +
 * LastError + age) becomes the honest, operator-facing verdict shown on BOTH
 * surfaces: the field tablet's /sync page and the cloud's PM view. It imports
 * NOTHING db-backed — no '@/lib/db-sqlite', no better-sqlite3, no fs/path — so a
 * Vite browser bundle can import it directly without dragging the SQLite driver
 * into the client chunk.
 *
 * WHY IT IS SPLIT OUT: lib/sync/queue-inspector.ts opens a Database at import
 * time, so importing displayVerdict from there into the client page pulled
 * better-sqlite3 into the /sync browser chunk. The page used to HAND-COPY this
 * logic to dodge that — a mirror that could silently drift from the canonical
 * code and reintroduce the exact "the tool shows something different from
 * reality" bug this feature exists to kill. Now the page and queue-inspector
 * both import from here, so the tablet and the cloud can never disagree.
 * queue-inspector re-exports this surface so its own importers (server routes,
 * heartbeat telemetry, tests) keep resolving unchanged.
 */

// 'auth_error' (HTTP 401/403 — the tablet's cloud key doesn't match this project)
// is its OWN classification, split out from the transient/network bucket: it is
// retryable (auto-recovers the instant the key is fixed — see
// isNetworkLevelFailure) but it is a NEEDS-ACTION state, never a benign one. A
// human must fix the key; the tool cannot heal it by waiting.
export type Classification = 'gone_on_cloud' | 'version_conflict' | 'transient' | 'cloud_rejected' | 'unknown' | 'auth_error'

/**
 * How long an ACTIVE (still-retrying) row may keep failing before the display
 * STOPS calling it "temporary — nothing to do" and escalates to "needs
 * attention — check the connection".
 *
 * The queue is meant to be minutes deep: auto-sync drains it every ~10 s. A row
 * that has been retrying past this threshold is not a blip — it is a link (or
 * config) that is genuinely not delivering, and telling the operator there is
 * nothing to do is the exact lie this exists to kill (a row failing for 24 h once
 * read "temporary network issue · nothing to do"). It does NOT change retry
 * behaviour — the row keeps retrying forever, which is correct; only the LABEL
 * escalates. Mirrors the heartbeat's QUEUE_AGE_WATCHDOG_MINUTES (15) so the
 * tablet and the fleet view agree on when a queue has gone stale.
 */
export const STALE_AFTER_MIN = 15

/**
 * Canonical per-classification reason text.
 *
 * PLAIN LANGUAGE CONTRACT (do not regress this):
 * These strings are read by field technicians on a tablet, not by the people who
 * wrote the queue. They must never contain internal vocabulary — "parked",
 * "dead-lettered", "orphaned", "stuck in queue", "retry cap exhausted" — because
 * those words describe our implementation, not the tech's situation.
 *
 * Each reason answers exactly two questions, in this order:
 *   1. What happened, in words that mean something on a warehouse floor.
 *   2. Whether anyone has to DO something, or whether the tool handles it.
 *
 * That second half is the part that must survive any future rewording. Blurring
 * "this is on its way" into "this will never arrive unless you act" would make
 * the tool quietly claim success — strictly worse than the jargon it replaced.
 *
 * Exported so the heartbeat's held-back telemetry ships the SAME explanation the
 * operator sees, WITHOUT the raw-LastError interpolation that `classify()`
 * appends for the cloud_rejected/unknown cases — see lib/heartbeat/queue-stats.ts
 * (raw LastError can carry a remote URL). Reuse this map; do not restate it.
 * The cloud renders these verbatim to PMs, so the plain-language contract above
 * governs both surfaces, not just the tablet.
 */
export const REASONS: Record<Classification, string> = {
  gone_on_cloud:
    'This record was removed on the cloud, so there is nothing left to send it to. Nothing to do — your entry stays saved on this device.',
  version_conflict:
    'The cloud already has a newer value for this item. Sending again will start from the cloud’s value.',
  transient:
    'A temporary network or cloud problem. Nothing to do — this sends itself once the connection recovers. Retry sends it now.',
  auth_error:
    'This tablet’s cloud key does not match this project, so the cloud is refusing everything from it. Someone has to fix the cloud key in Settings — then this sends on its own. Nothing is lost: your entry stays saved on this device.',
  cloud_rejected:
    'The cloud would not accept this value, and sending it again will not change that (for example an invalid value, or a SPARE that cannot be marked Passed). Check the value or the target, or Discard it if it is no longer needed.',
  unknown: 'This did not send and the cloud gave no reason — Retry, or Discard it if it is no longer needed.',
}

/**
 * If a LastError describes an AUTH failure — HTTP 401 (missing/bad credential) or
 * 403 (the tablet's cloud key doesn't match this project) — return that status;
 * else null.
 *
 * ONE detector, used by BOTH classify() and displayVerdict(), so the two surfaces
 * can never disagree about whether a row is an auth failure. It mirrors the
 * status-based isAuthFailure() in lib/cloud/sync-failure-classification.ts, but
 * works from the stored LastError STRING (all a queue row carries): the drain
 * writes these verbatim — 'HTTP 403', 'HTTP 401 auth failed',
 * 'HTTP 403 (network-level, no strike)'.
 */
export function authStatusFromError(lastError: string | null | undefined): 401 | 403 | null {
  const e = (lastError || '').toLowerCase()
  if (!e) return null
  if (/\b401\b/.test(e) || /unauthori[sz]ed|auth failed|invalid api key/.test(e)) return 401
  if (/\b403\b/.test(e) || /forbidden|wrong project|project.?key mismatch/.test(e)) return 403
  return null
}

/**
 * Map a raw LastError string to a plain-English classification + reason.
 * Order matters: AUTH (401/403) is checked FIRST, then 'gone' and 'conflict'
 * before the broad transient network bucket, so a 404/409 is never mislabelled as
 * a network blip and a 401/403 is never mislabelled as "removed" or "temporary".
 */
export function classify(lastError: string | null): { classification: Classification; reason: string } {
  const e = (lastError || '').toLowerCase()
  if (!e) return { classification: 'unknown', reason: REASONS.unknown }

  // AUTH first. A 401/403 is the tablet's cloud key not matching this project —
  // DETERMINISTIC, never self-heals until a human fixes the key. It must never
  // fall through to the "removed on cloud" bucket (403 used to hit \b40[34]\b
  // below and read as a safe-to-discard removal — the same mislabel that
  // tombstoned unsynced work in the 2026-07-17 incident) or the "temporary
  // network" bucket ("nothing to do"). Retry-forever is correct and UNCHANGED;
  // it is the LABEL that must say "a human fixes this", not "it fixes itself".
  if (authStatusFromError(e) != null) {
    return { classification: 'auth_error', reason: REASONS.auth_error }
  }
  // Only a true HTTP removal (404/410) is "gone — safe to discard". 403 is NOT
  // here any more: it is auth (handled above), not a removal.
  // NOTE: updatedCount=0 is intentionally NOT here — it's an ambiguous
  // version-mismatch ghost the B7 reconcile heals, so it must read as a
  // version conflict (retry/auto-heals), never "safe to discard".
  if (/\b404\b|410|not found|no longer exists|does not exist/.test(e)) {
    return { classification: 'gone_on_cloud', reason: REASONS.gone_on_cloud }
  }
  if (/version|rebased|409|conflict|updatedcount=0/.test(e)) {
    return { classification: 'version_conflict', reason: REASONS.version_conflict }
  }
  if (/timeout|econn|network|fetch failed|5\d\d|socket|offline/.test(e)) {
    return { classification: 'transient', reason: REASONS.transient }
  }
  // A definitive cloud rejection of the VALUE — a 4xx other than the gone/conflict
  // cases already handled above (400/422 invalid, SPARE-can't-pass, permission),
  // or a row that exhausted its retries against such a rejection. Retrying won't
  // help. Append the raw cloud text so the operator sees exactly what it said.
  if (/\b4\d\d\b|rejected|invalid|not allowed|spare|cap exhausted|retry cap|permanent/.test(e)) {
    return { classification: 'cloud_rejected', reason: `${REASONS.cloud_rejected} (Cloud said: ${lastError})` }
  }
  // We don't specifically recognise this error, but there IS one — surface it
  // verbatim so the operator sees exactly what the cloud said (never a bare
  // "unknown" when a real message exists).
  return { classification: 'unknown', reason: `Cloud said: ${lastError}` }
}

/**
 * Age in whole minutes from a CreatedAt timestamp. Guards nulls and both
 * accepted shapes: ISO ('2026-07-14T10:00:00Z') and SQLite datetime('now')
 * ('2026-07-14 10:00:00', which is UTC). Returns null if unparseable.
 */
export function ageMinutesOf(createdAt: string | null | undefined): number | null {
  if (!createdAt) return null
  let s = String(createdAt).trim()
  if (!s) return null
  // Normalise the SQLite 'YYYY-MM-DD HH:MM:SS' (UTC, no zone marker) form so
  // JS doesn't parse it as local time.
  if (!s.includes('T') && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) {
    s = s.replace(' ', 'T')
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    s = s + 'Z'
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  const mins = Math.floor((Date.now() - t) / 60000)
  return mins < 0 ? 0 : mins
}

/**
 * Compact human duration for the display: 'under a minute', '12m', '3h', '2d'.
 * Rounds to a single unit — this is a "how long has it been stuck" hint, not a
 * stopwatch. Returns 'a while' for an unknown (null) age so the sentence still
 * reads (an old row with an unreadable CreatedAt is still old).
 */
export function formatDuration(mins: number | null | undefined): string {
  if (mins == null) return 'a while'
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${Math.round(mins)}m`
  const h = mins / 60
  if (h < 24) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

/** Display tone for a row — drives colour/icon on the operator surface. */
export type DisplayTone = 'sending' | 'attention' | 'auth' | 'resolved' | 'gone'

/**
 * The honest, operator-facing verdict for ONE row. Separate from `classification`
 * (the machine bucket): the verdict folds in the row's STATUS and AGE, which is
 * what lets it escalate a long-failing row off "sending" and pull a 401/403 out
 * to its own "a human must act" tone.
 */
export interface DisplayVerdict {
  tone: DisplayTone
  /** Short state, plain language, no raw status codes. */
  headline: string
  /** One sentence: what it means + whether anyone must act. */
  detail: string
  /** True ⇒ a human has to do something; false ⇒ the tool handles it. */
  needsAction: boolean
}

/**
 * The row fields displayVerdict needs — a structural subset of QueueItem, so a
 * caller can pass a QueueItem straight in. Age may come pre-computed
 * (`ageMinutes`, as QueueItem carries it) or be derived from `createdAt`.
 */
export interface DisplayRow {
  status: 'pending' | 'parked' | 'orphaned' | 'resolved'
  lastError?: string | null
  retryCount?: number | null
  ageMinutes?: number | null
  createdAt?: string | null
  classification?: Classification
}

function parkedHeadline(c: Classification): string {
  switch (c) {
    case 'version_conflict': return 'Newer value on cloud'
    case 'cloud_rejected': return 'Cloud would not accept it'
    case 'gone_on_cloud': return 'Removed on cloud'       // normally caught earlier — defensive
    case 'auth_error': return 'Can’t send — cloud key is wrong' // normally caught earlier — defensive
    default: return 'Needs attention'
  }
}

/**
 * PURE (no I/O, no clock beyond the age already handed in): map a row's
 * (status, LastError/classification, age) to what the operator should actually be
 * told. This is the single place the Sync Center's per-row status becomes HONEST.
 *
 * Precedence (first match wins), and WHY each beats the next:
 *   1. resolved  — terminal, the tool already cleared it. Nothing to say but "done".
 *   2. auth      — a 401/403 is deterministic and a HUMAN must fix the key. It
 *                  beats age and parked/active state because reading those could
 *                  only ever make it sound more benign than it is. Regardless of age.
 *   3. gone      — the cloud target was removed (orphaned, or gone_on_cloud). Self-
 *                  heals; nothing to do.
 *   4. parked    — stopped, not a removal: a human decides. Keep the per-class reason.
 *   5. stale     — ACTIVE but past STALE_AFTER_MIN: still retrying (correct — field
 *                  data is never dropped) but NOT arriving. This is the line that
 *                  must stop saying "temporary — nothing to do" after minutes/hours.
 *   6. sending   — ACTIVE and fresh: genuinely on its way, no action needed.
 *
 * Retry cadence is untouched by all of this — the verdict only changes WORDS.
 */
export function displayVerdict(row: DisplayRow): DisplayVerdict {
  const ageMin = row.ageMinutes != null ? row.ageMinutes : ageMinutesOf(row.createdAt ?? null)
  const classification = row.classification ?? classify(row.lastError ?? null).classification

  // 1. Terminal — the tool cleared it by itself.
  if (row.status === 'resolved') {
    return {
      tone: 'resolved',
      headline: 'Cleared automatically',
      detail: 'The cloud record was removed, so the tool cleared this by itself. Nothing to do.',
      needsAction: false,
    }
  }

  // 2. AUTH — beats everything below, at ANY age. Detected from the LastError
  // string (all a queue row carries) or an explicit auth_error classification.
  const authStatus = authStatusFromError(row.lastError) ?? (classification === 'auth_error' ? 403 : null)
  if (authStatus != null) {
    return {
      tone: 'auth',
      headline: 'Can’t send — cloud key is wrong',
      // The raw HTTP code is allowed here in the detail (it helps support); it is
      // NOT the headline. Plain instruction + reassurance follow it.
      detail: `This tablet’s cloud key does not match this project (HTTP ${authStatus}). Fix the cloud key in Settings and it sends on its own. Your data is safe on this device.`,
      needsAction: true,
    }
  }

  // 3. Removed on cloud (confirmed) — nothing to send it to; auto-restores if it
  // comes back. Covers orphaned rows and any gone_on_cloud classification.
  if (row.status === 'orphaned' || classification === 'gone_on_cloud') {
    return {
      tone: 'gone',
      headline: 'Removed on cloud',
      detail: 'This record was removed on the cloud, so there is nothing left to send it to. Nothing to do — your entry stays saved on this device.',
      needsAction: false,
    }
  }

  // 4. Parked (stopped, not a removal) — a human must decide. Keep the honest,
  // plain per-classification reason (never the raw LastError — that lives in the
  // "Technical detail" fold on the tablet).
  if (row.status === 'parked') {
    return {
      tone: 'attention',
      headline: parkedHeadline(classification),
      detail: REASONS[classification],
      needsAction: true,
    }
  }

  // 5. ACTIVE but STALE — the honesty fix. It is still retrying (never dropped),
  // but it has NOT reached the cloud in a long time. Do not call this "temporary —
  // nothing to do": escalate and tell the operator to check the connection.
  if (ageMin != null && ageMin >= STALE_AFTER_MIN) {
    return {
      tone: 'attention',
      headline: 'Not reaching the cloud',
      detail: `This has been retrying for ${formatDuration(ageMin)} without getting through. Check the tablet’s connection — your entry stays saved here meanwhile.`,
      needsAction: true,
    }
  }

  // 6. ACTIVE and fresh — genuinely on its way.
  return {
    tone: 'sending',
    headline: 'Sending…',
    detail: 'On its way — no action needed.',
    needsAction: false,
  }
}
