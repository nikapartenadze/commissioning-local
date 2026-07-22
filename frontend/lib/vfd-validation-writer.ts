/**
 * VFD Validation Writer — background service that ensures PLC validation flags
 * (Valid_Map, Valid_HP, Valid_Direction) are set for VFDs as soon as each
 * corresponding wizard step is complete — and keeps them set even after a PLC
 * power cycle, controller restart, or program download.
 *
 * PER-FLAG ASSERTION (Kevin taskboard #2170, 2026-06-04)
 * ------------------------------------------------------
 * This writer used to wait until the wizard's LAST step ("Check Direction")
 * was stamped, then assert all three flags at once. That coupled the keypad
 * F0/F1/F2 unlock (gated AOI-side on the Valid_* flags) to a SUCCESSFUL bump
 * test. But a failed bump means the VFD is "never ready for tracking" — so mech
 * never got the controls needed to troubleshoot the very failure they were
 * looking at.
 *
 * So we now assert each flag the moment its step is done, independently:
 *   - Valid_Map        ⇐ "Verify Identity" stamped            (Step 1)
 *   - Valid_HP         ⇐ "Motor HP (Field)" AND "VFD HP (Field)" filled (Step 2)
 *   - Valid_Direction  ⇐ "Check Direction" stamped (+ polarity pair) (Step 3)
 *
 * This also makes identity/HP durable across mid-wizard PLC downloads, not just
 * fully-commissioned drives. The AOI-side change — gating the keypad enable on
 * Valid_Map ALONE so mech gets F0/F1/F2 right after identity — is a controls-team
 * hand-off (Kevin), out of this tool's scope.
 *
 * ASSERT-ONLY semantics: this writer only ever writes 1s for EARNED flags. It
 * never writes a 0 for an un-earned flag — un-validation happens exclusively via
 * the explicit Invalidate clear pulses, never here. Polarity bits are written
 * only when "Check Direction" is stamped (a polarity stamp alone is not enough).
 *
 * SCHEDULING + EVENT-LOOP SAFETY (2026-06-05 MCM02 freeze)
 * ---------------------------------------------------------
 * This writer used to re-write EVERY earned flag EVERY 10 seconds using
 * synchronous FFI calls. On MCM02 (72 VFDs → 338 flags) each cycle blocked
 * the Node event loop for ~9.5 s out of every 10 — every API call took ~10 s,
 * the UI looked "stuck on loading" for all users, and the CIP hammering made
 * the main tag reader time out (91 connection flaps in one day). Two rules
 * now hold:
 *
 *   1. NEVER block the event loop: all PLC ops use the non-blocking
 *      initiate + waitForStatus pattern (createTagAsync / readTagAsync /
 *      writeTagAsync). A pass may take seconds of wall-clock; the server
 *      stays fully responsive throughout.
 *   2. NEVER write blindly on a timer: a pass runs only on a trigger that
 *      gives reason to believe PLC state diverged from L2 truth, and it
 *      reads each flag first, writing ONLY mismatches.
 *
 * Triggers (each → one full read-compare-write pass over all earned flags):
 *   1. PLC 'initialized' event  → IMMEDIATE pass. This is the durability
 *      path: power outage (hours), controller restart, and program download
 *      all drop the connection; on reconnect every flag (incl. the polarity
 *      pair) is re-asserted. knownMissingTags is cleared first (see below).
 *      LATENCY MATTERS here: mech may be standing at the drive waiting for
 *      the Valid_Map keypad unlock. With WRITE_CONCURRENCY tags in flight a
 *      full restore lands ~3-5 s after reconnect (3 s settle delay in
 *      plc-client-manager + a 2-5 s pass) — NOT minutes.
 *   2. L2 cell write / cloud pull → debounced pass (newly-earned flags).
 *   3. Periodic safety-net → every VFD_VALIDATION_SAFETY_NET_MS (default
 *      5 min). Catches the rare program download that completes without the
 *      CIP session ever formally dropping (same philosophy as
 *      KNOWN_MISSING_TTL_MS). Steady-state cost: ~1 read per flag per
 *      5 min, zero writes when nothing diverged.
 *
 * Between triggers: ZERO CIP traffic, zero event-loop usage.
 *
 * Escape hatches (field ops, no rebuild needed — NSSM AppEnvironmentExtra):
 *   VFD_VALIDATION_DISABLED=1        → writer fully off (emergency only;
 *                                      flags then NOT restored after downloads!)
 *   VFD_VALIDATION_SAFETY_NET_MS=N   → safety-net cadence override
 *
 * Only writes "check" flags — never motor commands (Bump, Run_At_30_RVS, etc.).
 */

import { db } from '@/lib/db-sqlite'
import {
  createTagAsync,
  readTagAsync,
  writeTagAsync,
  plc_tag_destroy,
  plc_tag_get_bit,
  plc_tag_get_float32,
  plc_tag_set_int8,
  PlcTagStatus,
  getStatusMessage,
  type PlcTagConfig,
} from '@/lib/plc'
import { configService } from '@/lib/config'
import { polarityFlagWrites, parsePolarity, type FlagWrite } from '@/lib/vfd-polarity'

// ── Types ──────────────────────────────────────────────────────────

/**
 * One row of the per-flag L2 query: a VFD device with ANY commissioning
 * progress. The `has*` columns are SQLite 0/1 flags (one per wizard step);
 * `polarityRaw` is the raw "Polarity" L2 cell.
 */
export interface ValidationRow {
  deviceName: string
  sheetName: string
  /** "Verify Identity" stamped (Step 1). */
  hasIdentity: number
  /** "Motor HP (Field)" filled (Step 2). */
  hasMotorHp: number
  /** "VFD HP (Field)" filled (Step 2). */
  hasVfdHp: number
  /** "Check Direction" stamped (Step 3). */
  hasDirection: number
  /** "Belt Tracked" cell == 'Yes' — mech marked it tracked on the cloud
   * belt-tracking page, pulled here via the L2 delta (2026-07-06). */
  hasBeltTracked: number
  /** Raw "Polarity" L2 cell ("… · Normal|Inverter"), or null when unrecorded. */
  polarityRaw: string | null
}

// Mirror the cloud contract (commissioning-cloud/lib/belt-tracking/types.ts):
// mech marks tracked by writing this L2 cell = 'Yes'.
export const BELT_TRACKED_COLUMN_NAME = 'Belt Tracked'
export const BELT_TRACKED_VALUE = 'Yes'

export interface ValidatedDevice {
  deviceName: string
  /** Pre-computed CMD writes (1s only) earned by this device's progress. */
  writes: FlagWrite[]
  /** Raw "Polarity" L2 cell — kept for the no-polarity-stamp diagnostic log. */
  polarityRaw: string | null
  /** Whether "Check Direction" is stamped — gates the no-polarity warning. */
  hasDirection: boolean
}

/**
 * Pure row→writes mapping. ASSERT-ONLY: emits only 1-valued Valid_* flags for
 * steps that are complete, never a 0 for an un-earned flag.
 *
 *   - Valid_Map        when hasIdentity
 *   - Valid_HP         when hasMotorHp AND hasVfdHp
 *   - Tracking_Finished when hasBeltTracked  (mech tracked it on the web app)
 *   - Valid_Direction  when hasDirection AND tracking is done*
 *   - polarity pair    when Valid_Direction is emitted AND a polarity is recorded
 *
 * TRACKING-IN-THE-MIDDLE (AOI rev 3.0, 2026-07-06): the AOI now gates
 * Valid_Direction on Tracking_Finished (rung 6). Mech marks the belt tracked on
 * the cloud belt-tracking page → the 'Belt Tracked'='Yes' L2 cell syncs here →
 * this writer bridges it to CMD.Tracking_Finished, which unlocks Valid_Direction
 * so the commissioner can finish the wizard (bump/polarity/speed).
 *
 * *Backward compat: the tracking gate applies ONLY when the device's sheet
 * actually defines a 'Belt Tracked' column (`hasBeltTrackedColumn`). On older
 * templates without it, Valid_Direction is emitted on hasDirection alone, so an
 * already-commissioned legacy drive is never stranded (its flags keep getting
 * re-asserted after a program download).
 *
 * The polarity bits are taken verbatim from polarityFlagWrites() so they can
 * never drift from the polarity helper's definition.
 */
export function flagsForDevice(row: ValidationRow, hasBeltTrackedColumn = false): FlagWrite[] {
  const writes: FlagWrite[] = []
  if (row.hasIdentity) writes.push({ field: 'Valid_Map', value: 1 })
  if (row.hasMotorHp && row.hasVfdHp) writes.push({ field: 'Valid_HP', value: 1 })
  // Bridge the mech's cloud "tracked" action to the PLC. Assert-only.
  if (row.hasBeltTracked) writes.push({ field: 'Tracking_Finished', value: 1 })
  // Direction validates only once tracking is done — mirror the AOI gate. On a
  // legacy sheet with no Belt Tracked column, keep the old behavior so already-
  // validated drives aren't regressed.
  const trackingSatisfied = row.hasBeltTracked === 1 || !hasBeltTrackedColumn
  if (row.hasDirection && trackingSatisfied) {
    writes.push({ field: 'Valid_Direction', value: 1 })
    // Polarity bits only ride along with a stamped, validatable direction check.
    writes.push(...polarityFlagWrites(row.polarityRaw))
  }
  return writes
}

// ── Belt-tracking freshness gate ───────────────────────────────────
//
// WHY (MCM15, 2026-07-22 — four hours lost):
// FOUR tool instances were simultaneously connected to MCM15 (two even sharing
// the hostname "autstand"). flagsForDevice() is ASSERT-ONLY and LEVEL-triggered
// on the local 'Belt Tracked' L2 cell: whenever the local cell says tracked it
// pushes Tracking_Finished=1 (+ Valid_Direction + polarity). The triggers are
// PLC reconnect, the 2 s l2-change debounce, and the 5-minute safety sweep.
//
// So ANY instance still holding a STALE 'Yes' re-latched Tracking_Finished on
// the SHARED controller minutes after someone cleared it elsewhere. Per rung 3
// of AOI_IOCT_BELT_TRACKING, a latched Tracking_Finished transfers polarity
// ownership away from the keypad (`XIO(Tracking_Finished) [XIC(Flip_Polarity)
// OTL(Reverse_Polarity) ...]` only runs while the latch is CLEAR) — so mechanics
// physically could not change belt direction, and an engineer had to remote into
// every instance by hand to find the one writing back.
//
// The rule: an instance must not assert belt-tracking flags from a local cell it
// has not RECENTLY CONFIRMED against the cloud. Silence is the safe failure —
// the AOI latch is retentive, so declining to assert never un-does correct
// state, whereas asserting from stale data actively breaks the plant.
//
// FRESHNESS SOURCE (reused, no parallel store — see the report):
//   (a) LIVE  — the cloud SSE client (lib/cloud/cloud-sse-client.ts). It is the
//       channel the untrack hint arrives on; `isConnected` + `lastEventAt`
//       (bumped by the cloud's own heartbeat/ping frames, not just data events)
//       proves this instance is on the live hint channel RIGHT NOW. Process-
//       scoped by construction, which satisfies the "never this process" rule.
//   (b) DURABLE — SyncCursors.UpdatedAt for the subsystem (lib/cloud/
//       sync-cursor.ts), the per-subsystem delta cursor. It proves a cloud delta
//       for THIS subsystem was actually applied here. Because setSyncCursor only
//       bumps UpdatedAt when the cursor ADVANCES, it goes stale during quiet
//       periods and can NEVER be the sole signal — and because it survives
//       restarts, it is additionally required to post-date process start so a
//       freshly-booted offline instance can't inherit a pre-restart stamp.
//
// Only the belt-tracking WRITES are gated. Valid_Map / Valid_HP come from local
// wizard truth (identity + HP cells), not from a cloud belt-tracking decision,
// and keep flowing so mech never loses the keypad unlock. Nothing on any
// read-only/status path is gated.

/** Flags whose assertion depends on cloud-confirmed belt-tracking truth. */
export const BELT_TRACKING_GATED_FIELDS = [
  'Tracking_Finished',
  'Valid_Direction',
  'Normal_Polarity',
  'Reverse_Polarity',
] as const

/**
 * How recently this instance must have confirmed belt-tracking truth against
 * the cloud before it may assert the gated flags. Default 15 min — long enough
 * to ride out a brief WAN blip, short enough that a genuinely disconnected
 * instance stops fighting its peers well inside a shift.
 */
export const BELT_TRACKING_FRESHNESS_MS = (() => {
  const n = parseInt(process.env.VFD_BELT_TRACKING_FRESHNESS_MS || '', 10)
  return Number.isFinite(n) && n >= 60_000 ? n : 15 * 60_000
})()

/** Module load = process start, for the "never confirmed THIS process" rule. */
const PROCESS_START_MS = Date.now()

/** Everything judgeBeltTrackingFreshness needs — injectable for tests. */
export interface FreshnessProbe {
  /** Cloud SSE stream currently in the 'connected' state. */
  sseConnected: boolean
  /** epoch ms of the last SSE frame (incl. heartbeat/ping), or null. */
  sseLastEventMs: number | null
  /** epoch ms of SyncCursors.UpdatedAt for the subsystem, or null. */
  cursorUpdatedMs: number | null
}

export interface FreshnessVerdict {
  fresh: boolean
  /** Human-readable WHY, for the throttled log line. */
  reason: string
}

/**
 * Decide whether this instance may assert belt-tracking flags for a subsystem.
 *
 * PURE. Fresh iff EITHER:
 *   (a) the cloud SSE stream is connected AND produced a frame within the
 *       window — this instance is on the live untrack-hint channel; or
 *   (b) a cloud delta for this subsystem was applied within the window AND
 *       that happened after process start (a durable pre-restart stamp is not
 *       evidence that THIS process ever reached the cloud).
 *
 * Everything else — offline, SSE dropped, never synced, no cloud configured —
 * is STALE, and stale means QUIET.
 */
export function judgeBeltTrackingFreshness(
  probe: FreshnessProbe,
  nowMs: number,
  processStartMs: number = PROCESS_START_MS,
  thresholdMs: number = BELT_TRACKING_FRESHNESS_MS,
): FreshnessVerdict {
  const { sseConnected, sseLastEventMs, cursorUpdatedMs } = probe

  if (sseConnected && sseLastEventMs != null) {
    const age = nowMs - sseLastEventMs
    if (age >= 0 && age <= thresholdMs) {
      return { fresh: true, reason: `cloud SSE live (last frame ${Math.round(age / 1000)}s ago)` }
    }
  }

  if (cursorUpdatedMs != null && cursorUpdatedMs > processStartMs) {
    const age = nowMs - cursorUpdatedMs
    if (age >= 0 && age <= thresholdMs) {
      return { fresh: true, reason: `cloud delta applied ${Math.round(age / 1000)}s ago` }
    }
  }

  // Stale — spell out which leg failed so the field log is actionable.
  const sseNote = !sseConnected
    ? 'cloud SSE not connected'
    : sseLastEventMs == null
      ? 'cloud SSE connected but no frame received yet'
      : `last SSE frame ${Math.round((nowMs - sseLastEventMs) / 1000)}s ago`
  const cursorNote = cursorUpdatedMs == null
    ? 'no delta cursor for this subsystem'
    : cursorUpdatedMs <= processStartMs
      ? 'delta cursor predates this process start (never confirmed since boot)'
      : `last delta applied ${Math.round((nowMs - cursorUpdatedMs) / 1000)}s ago`
  return { fresh: false, reason: `${sseNote}; ${cursorNote}` }
}

/**
 * Drop the belt-tracking-dependent writes from a device's flag list, leaving
 * Valid_Map / Valid_HP intact. Returns the SAME array reference when nothing
 * is gated, so the common (fresh) path allocates nothing.
 */
export function stripBeltTrackingWrites(writes: FlagWrite[]): FlagWrite[] {
  const gated = BELT_TRACKING_GATED_FIELDS as readonly string[]
  if (!writes.some(w => gated.includes(w.field))) return writes
  return writes.filter(w => !gated.includes(w.field))
}

// Throttle the "skipping, stale" log to once per subsystem per freshness
// window. Without this a 5-minute sweep plus every reconnect and every
// l2-change debounce would flood the field log.
const lastStaleLogMsBySubsystem = new Map<string, number>()

function logStaleOnce(subsystemKey: string, reason: string, heldBack: number, nowMs: number): void {
  const last = lastStaleLogMsBySubsystem.get(subsystemKey) ?? 0
  if (nowMs - last < BELT_TRACKING_FRESHNESS_MS) return
  lastStaleLogMsBySubsystem.set(subsystemKey, nowMs)
  console.warn(
    `[VfdValidationWriter] Belt-tracking flags HELD BACK for subsystem ${subsystemKey}: ` +
    `local 'Belt Tracked' state not confirmed against the cloud within ` +
    `${Math.round(BELT_TRACKING_FRESHNESS_MS / 60_000)} min (${reason}). ` +
    `${heldBack} device(s) affected — Tracking_Finished / Valid_Direction / polarity NOT asserted. ` +
    'Valid_Map and Valid_HP are unaffected. This is deliberate: asserting from stale local state ' +
    'on a shared controller re-latches tracking and locks mechanics out of the keypad.',
  )
}

/** Read SyncCursors.UpdatedAt (stored as UTC `datetime('now')` text) as epoch ms. */
function readCursorUpdatedMs(subsystemId: string): number | null {
  try {
    const row = db
      .prepare('SELECT UpdatedAt FROM SyncCursors WHERE SubsystemId = ?')
      .get(parseInt(subsystemId, 10)) as { UpdatedAt: string | null } | undefined
    if (!row?.UpdatedAt) return null
    // SQLite datetime('now') is UTC without a zone suffix — parse it as UTC.
    const ms = Date.parse(`${row.UpdatedAt.replace(' ', 'T')}Z`)
    return Number.isFinite(ms) ? ms : null
  } catch {
    // Table absent (older DB) → no evidence of confirmation → stale.
    return null
  }
}

/** Live probe: SSE liveness + this subsystem's durable delta cursor. */
async function probeFreshness(subsystemId: string): Promise<FreshnessProbe> {
  let sseConnected = false
  let sseLastEventMs: number | null = null
  try {
    const { getCloudSseClient } = await import('@/lib/cloud/cloud-sse-client')
    const sse = getCloudSseClient()
    if (sse) {
      sseConnected = sse.isConnected
      sseLastEventMs = sse.lastEventAt ? sse.lastEventAt.getTime() : null
    }
  } catch { /* cloud SSE module unavailable → treat as not connected */ }
  return { sseConnected, sseLastEventMs, cursorUpdatedMs: readCursorUpdatedMs(subsystemId) }
}

// ── Throttle / state ───────────────────────────────────────────────

let lastSyncMs = 0
let syncRunning = false
let pendingSync = false
const MIN_SYNC_INTERVAL_MS = 5_000 // at most once per 5 s

// Emergency kill switch — see file header. When set, the writer never touches
// the PLC; validation/polarity flags will NOT be restored after a download.
const WRITER_DISABLED = process.env.VFD_VALIDATION_DISABLED === '1'

// Split deployment (Phase 1.1): in PLC_MODE=remote the libplctag FFI lives in
// the plc-gateway process — the writer (which needs SQLite/L2 truth and so
// runs in the APP) converges flags through the gateway's typed-batch
// endpoints instead of direct FFI. Same read-compare-write semantics; the
// gateway executes the actual CIP traffic with its own non-blocking sweeps.
const PLC_REMOTE = process.env.PLC_MODE === 'remote'

// Safety-net cadence. 5 min default: the only scenario it exists for is a
// program download that never drops the CIP session (rare); everything common
// (power loss, controller restart, normal download) is handled IMMEDIATELY by
// the PLC 'initialized' trigger.
const SAFETY_NET_MS = (() => {
  const n = parseInt(process.env.VFD_VALIDATION_SAFETY_NET_MS || '', 10)
  return Number.isFinite(n) && n >= 30_000 ? n : 5 * 60_000
})()

// Tags processed concurrently within a pass. The post-download restore must
// be FAST — mech may be standing at a drive waiting for the keypad unlock
// (Valid_Map gate), so a power-up/download restore should complete seconds
// after reconnect, not tens of seconds. 8 outstanding CIP requests is mild
// for a ControlLogix (the IO tag reader batch-creates 592 tags at connect);
// the mass-failure circuit breaker still aborts a sick pass quickly.
const WRITE_CONCURRENCY = (() => {
  const n = parseInt(process.env.VFD_VALIDATION_CONCURRENCY || '', 10)
  return Number.isFinite(n) && n >= 1 && n <= 32 ? n : 8
})()

// Tags that returned a definitive PLCTAG_ERR_NOT_FOUND, keyed `${gateway}::${tagPath}`.
// Once a CMD flag tag is known absent on a given PLC we stop re-creating it every
// sync. Cleared on every PLC (re)connect via clearKnownMissingTags() — a reconnect
// often follows a program download, after which the tag inventory may have changed
// (and a NOT_FOUND answered mid-download is not durable truth). Between connects it
// prevents recurring passes from re-spamming failing createTag calls at the
// controller's CIP queue for tags the program genuinely doesn't define.
const knownMissingTags = new Set<string>()

/**
 * A createTag status that is a DEFINITIVE "this tag path is not usable in this
 * program" verdict (vs. a transient CIP/timeout/busy failure that should be
 * retried). Such tags are cached in knownMissingTags and skipped until the next
 * (re)connect clears the cache.
 *
 * Includes BAD_PARAM and UNSUPPORTED alongside NOT_FOUND: a belt-tracking CMD
 * member like `CBT_<drive>_VFD.CTRL.CMD.Tracking_Finished` that isn't in the
 * downloaded AOI answers BAD_PARAM, not NOT_FOUND, so it escaped the cache and
 * was re-created on EVERY validation pass — thousands of doomed createTag calls
 * per day at the controller's CIP queue (MCM04 forensics 2026-07-16). These
 * statuses are construction-time verdicts, permanent for that path until the
 * program changes (a program download drops the connection → cache cleared).
 */
export function isDefinitiveMissingTagStatus(status: number): boolean {
  return (
    status === PlcTagStatus.PLCTAG_ERR_NOT_FOUND ||
    status === PlcTagStatus.PLCTAG_ERR_BAD_PARAM ||
    status === PlcTagStatus.PLCTAG_ERR_UNSUPPORTED
  )
}

/**
 * Forget every cached "tag not in program" verdict. MUST be called whenever
 * the PLC client (re)initializes: program downloads drop the connection, and
 * a download can add tags that were previously absent — or have answered
 * NOT_FOUND for tags that exist, while the transfer was in flight. Without
 * this, the writer permanently skipped those CMD flags until a tool restart,
 * leaving polarity/validation bits unrestored after a download (CDW5, June 2026).
 */
export function clearKnownMissingTags(reason: string, resetLocalControl = true): void {
  lastKnownMissingClearMs = Date.now()
  // A (re)connect usually means a program download just landed, which drops
  // Valid_Map/Valid_HP and reinitialises the AOI's local tags — so every
  // untracked belt's keypad may have just gone dead. Forget the local-control
  // backoff so the next pass re-evaluates immediately instead of leaving
  // mechanics without a keypad for up to LOCAL_CONTROL_REASSERT_MS.
  // The periodic TTL sweep passes false: it is not evidence of anything
  // changing on the controller, and letting it reset the backoff would
  // silently shorten the rate limit to KNOWN_MISSING_TTL_MS.
  if (resetLocalControl) resetLocalControlBackoff()
  if (knownMissingTags.size === 0) return
  console.log(`[VfdValidationWriter] Cleared ${knownMissingTags.size} known-missing tag(s): ${reason}`)
  knownMissingTags.clear()
}

// Belt-and-suspenders TTL: even if a program download completes WITHOUT the
// client ever formally dropping the connection (CIP session heals in place →
// no 'initialized' event → no reconnect-triggered cache clear), no NOT_FOUND
// verdict may outlive this window. Worst case a genuinely-missing tag costs
// one extra createTag attempt per TTL — negligible vs. a drive whose
// validation/polarity flags are silently never written again.
const KNOWN_MISSING_TTL_MS = 10 * 60_000
let lastKnownMissingClearMs = Date.now()

function expireKnownMissingTags(): void {
  const now = Date.now()
  if (now - lastKnownMissingClearMs < KNOWN_MISSING_TTL_MS) return
  lastKnownMissingClearMs = now
  clearKnownMissingTags('periodic TTL expiry — re-probing tags previously reported missing', false)
}

// ── Mass-failure circuit breaker ────────────────────────────────────
// When the PLC's EtherNet/IP ring breaks (e.g. the 2026-05-28 16:30 UTC
// CDW5 incident), many devices flip ConnectionFaulted=true simultaneously.
// Before this guard, the writer attempted createTag for every validated VFD
// regardless of fault state, holding ~5 s of CIP slot per doomed handle.
// That saturated the controller's CIP queue and starved the IO tag reader,
// which then mistakenly declared the PLC unreachable and the "Connection
// Lost — Reconnecting" banner appeared and could not clear without an NSSM
// service restart. Two new guards prevent that wedge:
//   1. Skip devices whose `:I.ConnectionFaulted` is true in the cached tag
//      state. Zero CIP traffic to known-down devices.
//   2. Fast-abort the cycle after N consecutive createTag failures. Even if
//      cache is stale (e.g. ring just broke this second), we stop after a
//      handful of timeouts instead of marching through 100 devices.
const MAX_CONSECUTIVE_CREATE_FAILURES = 5

// createTag timeout for validation writes. The happy-path response from a
// healthy ControlLogix is 50-200 ms; 5 s was overkill and meant a doomed
// handle held its CIP slot for 5 full seconds before timeout. 2 s still
// gives a generous margin on a slow controller and fails fast on a dead
// device, releasing the slot for other CIP traffic.
const CREATE_TAG_TIMEOUT_MS = 2_000

/**
 * Build a Set of validated-device names that are currently faulted on the
 * EtherNet/IP ring. Looks each device's `:I.ConnectionFaulted` bit up in
 * the PLC client's tag cache (populated by the network status reader; the
 * IO tag reader's main loop refreshes it every ~75 ms).
 *
 * Semantics — what counts as "skip":
 *   - true   → SKIP (device is down per the controller's view)
 *   - false  → DO NOT SKIP (device is up)
 *   - null   → DO NOT SKIP (tag not loaded yet, e.g. fresh boot before the
 *              network-status endpoint has been hit). Letting it through
 *              preserves the existing behavior; if the device really is
 *              down, the createTag will time out and the mass-failure
 *              circuit breaker downstream will catch it.
 *
 * Cost is O(devices), no fresh PLC reads.
 */
function buildFaultedDeviceSet(
  readTagCached: (name: string) => boolean | null,
  devices: ValidatedDevice[],
): Set<string> {
  const faulted = new Set<string>()
  for (const device of devices) {
    const faultTag = `${device.deviceName}:I.ConnectionFaulted`
    if (readTagCached(faultTag) === true) {
      faulted.add(device.deviceName)
    }
  }
  return faulted
}

// ── L2 query ───────────────────────────────────────────────────────

/**
 * Return every VFD device that has ANY commissioning progress, with a per-flag
 * breakdown (one row per device). A device qualifies if identity is stamped, OR
 * both HP cells are filled, OR direction is stamped — so each Valid_* flag can
 * be asserted as soon as its own step is complete (per-flag assertion, #2170),
 * rather than waiting for the final "Check Direction" step.
 *
 * Note on "Check Direction": a literal "fail" is recorded as a non-empty cell,
 * so `hasDirection` would be 1 for it. flagsForDevice() must therefore NOT
 * treat a failed direction check as direction-valid. We keep the existing
 * guard by excluding lowercase "fail" from counting toward hasDirection
 * directly in the CASE expression (cv.Value <> '' already excludes empty).
 *
 * The polarity cell is folded in via a conditional MAX(... ) aggregate.
 */
/**
 * The set of VFD/APF sheet NAMES whose template defines a 'Belt Tracked'
 * column. Used to apply the tracking gate on Valid_Direction only to
 * new-flow templates; sheets without the column keep the legacy behavior.
 */
function getSheetsWithBeltTrackedColumn(): Set<string> {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT s.Name AS sheetName
      FROM L2Sheets s
      JOIN L2Columns c ON c.SheetId = s.id
      WHERE c.Name = '${BELT_TRACKED_COLUMN_NAME}'
    `).all() as Array<{ sheetName: string }>
    return new Set(rows.map(r => r.sheetName))
  } catch (err) {
    console.error('[VfdValidationWriter] Belt-tracked-column query failed:', err)
    return new Set()
  }
}

function getValidatedDevices(): ValidatedDevice[] {
  try {
    const rows = db.prepare(`
      SELECT d.DeviceName AS deviceName, s.Name AS sheetName,
             MAX(CASE WHEN c.Name = 'Verify Identity'  AND TRIM(cv.Value) <> '' THEN 1 ELSE 0 END) AS hasIdentity,
             MAX(CASE WHEN c.Name = 'Motor HP (Field)' AND TRIM(cv.Value) <> '' THEN 1 ELSE 0 END) AS hasMotorHp,
             MAX(CASE WHEN c.Name = 'VFD HP (Field)'   AND TRIM(cv.Value) <> '' THEN 1 ELSE 0 END) AS hasVfdHp,
             MAX(CASE WHEN c.Name = 'Check Direction'  AND TRIM(cv.Value) <> '' AND LOWER(TRIM(cv.Value)) <> 'fail' THEN 1 ELSE 0 END) AS hasDirection,
             MAX(CASE WHEN c.Name = '${BELT_TRACKED_COLUMN_NAME}' AND LOWER(TRIM(cv.Value)) = '${BELT_TRACKED_VALUE.toLowerCase()}' THEN 1 ELSE 0 END) AS hasBeltTracked,
             MAX(CASE WHEN c.Name = 'Polarity' THEN cv.Value END) AS polarityRaw
      FROM L2Devices d
      JOIN L2Sheets s   ON s.id = d.SheetId
      JOIN L2Columns c  ON c.SheetId = d.SheetId
      JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
      WHERE cv.Value IS NOT NULL AND cv.Value <> ''
        AND (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
      GROUP BY d.DeviceName, s.Name
      HAVING hasIdentity = 1 OR (hasMotorHp = 1 AND hasVfdHp = 1) OR hasDirection = 1 OR hasBeltTracked = 1
    `).all() as ValidationRow[]

    // Which sheets actually DEFINE a Belt Tracked column — the tracking gate on
    // Valid_Direction applies only to these (legacy sheets keep old behavior).
    const beltTrackedSheets = getSheetsWithBeltTrackedColumn()

    return rows.map(row => ({
      deviceName: row.deviceName,
      writes: flagsForDevice(row, beltTrackedSheets.has(row.sheetName)),
      polarityRaw: row.polarityRaw,
      hasDirection: row.hasDirection === 1,
    }))
  } catch (err) {
    console.error('[VfdValidationWriter] DB query failed:', err)
    return []
  }
}

/**
 * deviceName (uppercased) → owning SubsystemId, derived from the Ios table's
 * NetworkDeviceName column. Used to route each validated VFD's flag writes to
 * the PLC that actually owns the drive in multi-MCM deployments. Devices that
 * don't resolve here keep the legacy behavior (active singleton PLC).
 */
function getDeviceSubsystemMap(): Map<string, string> {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT NetworkDeviceName AS deviceName, SubsystemId AS subsystemId
      FROM Ios
      WHERE NetworkDeviceName IS NOT NULL AND NetworkDeviceName != '' AND SubsystemId IS NOT NULL
    `).all() as Array<{ deviceName: string; subsystemId: number }>
    const map = new Map<string, string>()
    for (const row of rows) map.set(row.deviceName.toUpperCase(), String(row.subsystemId))
    return map
  } catch (err) {
    console.error('[VfdValidationWriter] device→subsystem query failed:', err)
    return new Map()
  }
}

// Devices last reported as "validated but no polarity stamp" — used to log the
// list only when it CHANGES, not every 10 s cycle. These drives get
// Valid_Direction force-set while their Normal/Reverse_Polarity bits are left
// at whatever the last program download carried (typically 0/0) — i.e. they
// silently revert to default direction and the tool cannot restore them.
let lastNoPolarityKey = ''

// ── Batch write ────────────────────────────────────────────────────

/**
 * PLC operations used by batchWriteFlags. Injectable so the pass logic
 * (skip/verify/write/circuit-breaker/abort decisions) is unit-testable
 * without a DLL or a controller. Production default: the real async
 * libplctag wrappers.
 */
export interface PlcWriteOps {
  createTagAsync: (config: PlcTagConfig, timeoutMs: number) => Promise<{ handle: number; status: number }>
  readTagAsync: (handle: number, timeoutMs: number) => Promise<number>
  writeTagAsync: (handle: number, timeoutMs: number) => Promise<number>
  /** Read bit 0 of the tag buffer: 0/1, or a NEGATIVE libplctag error code. */
  getBit: (handle: number, offsetBit: number) => number
  setInt8: (handle: number, offset: number, value: number) => number
  destroy: (handle: number) => void
}

const realOps: PlcWriteOps = {
  createTagAsync,
  readTagAsync,
  writeTagAsync,
  // plc_tag_get_bit, NOT plc_tag_get_int8: get_int8 is declared I32 over a C
  // int8_t return, so the upper register bytes are ABI GARBAGE — truthiness
  // checks on it are meaningless (caught by the battle env on 2026-06-05:
  // every zeroed flag read "already-correct" and restore silently no-opped).
  // get_bit returns a clean int 0/1 and is the convention everywhere else
  // (tag-reader.ts, plc-client.ts, vfd-wizard-reader.ts).
  getBit: plc_tag_get_bit,
  setInt8: plc_tag_set_int8,
  destroy: plc_tag_destroy,
}

export interface BatchResult {
  /** Flags actually written (PLC value diverged from L2 truth). */
  ok: number
  /** Flags read and already correct — no write issued. */
  verified: number
  fail: number
  skipped: number
  skippedFaulted: number
  abortedAt: number | null
  /** Pass stopped early because the PLC client reported disconnected. */
  disconnected: boolean
}

/**
 * Compare a plc_tag_get_bit() result (clean 0/1) against the desired 0/1.
 * Truthiness comparison keeps this robust if a controller ever reports a
 * nonstandard nonzero for "set".
 */
function boolMismatch(currentBit: number, desired: number): boolean {
  return (currentBit !== 0) !== (desired !== 0)
}

/** One (device, flag) unit of work within a pass. */
interface FlagJob {
  deviceIdx: number
  tagPath: string
  cacheKey: string
  value: number
}

/**
 * One full convergence pass: for every earned flag, read the PLC's current
 * value and write ONLY if it diverges from L2 truth.
 *
 * Event-loop safety: every PLC op is non-blocking (initiate + poll), so the
 * server stays responsive regardless of pass duration.
 *
 * Speed: jobs run through a small worker pool (WRITE_CONCURRENCY outstanding
 * tags). The post-download restore is the latency-critical path — mech waits
 * at the drive for the Valid_Map keypad unlock — so a full 338-flag restore
 * must land seconds after reconnect. At ~8 concurrent ops a healthy
 * ControlLogix converges ~340 flags in roughly 2-5 s.
 *
 * `isConnected` is checked before each job: a PLC that drops mid-pass aborts
 * the pass instead of marching 300 tags into 2 s timeouts. The reconnect
 * trigger re-runs the whole pass anyway.
 */
export async function batchWriteFlags(
  gateway: string,
  path: string,
  devices: ValidatedDevice[],
  faultedDevices: Set<string>,
  isConnected: () => boolean,
  ops: PlcWriteOps = realOps,
  concurrency: number = WRITE_CONCURRENCY,
): Promise<BatchResult> {
  let ok = 0
  let verified = 0
  let fail = 0
  let skipped = 0
  // Devices we deliberately did NOT touch because they're currently in
  // ConnectionFaulted state. Separate counter from `skipped` (which counts
  // tags known absent from the PLC program) so the log line lets operators
  // see "we held back 50 devices because the ring is broken" vs "this PLC's
  // program doesn't define these tags".
  let skippedFaulted = 0
  // If we trip the mass-failure circuit breaker, remember the device index
  // we stopped at so the log line is actionable.
  let abortedAt: number | null = null
  let disconnected = false
  // Count of consecutive createTag failures across the pass (in completion
  // order under concurrency — an approximation, but 5 transient failures
  // back-to-back still unambiguously means "CIP queue is sick"). Resets on
  // any success.
  let consecutiveCreateFailures = 0

  // ── Build the job list (pure, no PLC traffic) ────────────────────
  const jobs: FlagJob[] = []
  for (let deviceIdx = 0; deviceIdx < devices.length; deviceIdx++) {
    const device = devices[deviceIdx]

    // Skip devices currently in ConnectionFaulted/Communication_Faulted.
    // Their CTRL.CMD tags live on the controller but the controller is
    // routing traffic to a dead endpoint when these get written, which
    // is what saturated the CIP queue in the 2026-05-28 incident. The
    // device will be re-tried automatically on the next pass once
    // ConnectionFaulted flips back to false (the IO reader updates the
    // cache continuously).
    if (faultedDevices.has(device.deviceName)) {
      // Count once per device regardless of how many flag writes it
      // would have produced — easier to read in the log line.
      skippedFaulted++
      continue
    }

    // Per-flag earned writes (=1 only) + polarity bits (only when direction
    // is stamped and a polarity is recorded). Pre-computed by flagsForDevice.
    for (const { field, value } of device.writes) {
      const tagPath = `CBT_${device.deviceName}.CTRL.CMD.${field}`
      const cacheKey = `${gateway}::${tagPath}`
      // Skip tags already proven absent on THIS PLC — see knownMissingTags.
      if (knownMissingTags.has(cacheKey)) {
        skipped++
        continue
      }
      jobs.push({ deviceIdx, tagPath, cacheKey, value })
    }
  }

  // ── Run one job: create → read → compare → (write) → destroy ────
  const runJob = async (job: FlagJob): Promise<void> => {
    const { handle, status } = await ops.createTagAsync(
      { gateway, path, name: job.tagPath, elemSize: 1, elemCount: 1 },
      CREATE_TAG_TIMEOUT_MS,
    )
    try {
      if (status !== PlcTagStatus.PLCTAG_STATUS_OK) {
        fail++
        consecutiveCreateFailures++
        // Cache ONLY definitive "not in the program" results (NOT_FOUND /
        // BAD_PARAM / UNSUPPORTED). Transient failures (timeout/busy/connection)
        // must NOT be cached — the tag may exist and should be retried once the
        // PLC is responsive again.
        if (isDefinitiveMissingTagStatus(status)) {
          knownMissingTags.add(job.cacheKey)
          // A definitive verdict from the controller — don't count it as a
          // "CIP queue is sick" signal.
          consecutiveCreateFailures = 0
        }
        if (fail <= 3) {
          console.warn(`[VfdValidationWriter] createTag failed: ${job.tagPath}: ${getStatusMessage(status)}`)
        }
        // Mass-failure circuit breaker. N transient failures in a row →
        // the CIP queue is saturated (or the controller is briefly
        // unreachable). Stop hammering it; the next trigger retries.
        if (consecutiveCreateFailures >= MAX_CONSECUTIVE_CREATE_FAILURES && abortedAt == null) {
          abortedAt = job.deviceIdx
        }
        return
      }
      consecutiveCreateFailures = 0

      // Read-compare-write: only touch the PLC when its value actually
      // diverged (post-download restore, manual clear). Steady state —
      // everything already asserted — issues ZERO writes.
      const readSt = await ops.readTagAsync(handle, 2000)
      if (readSt !== PlcTagStatus.PLCTAG_STATUS_OK) {
        // Don't write blind through a sick connection — count and move on;
        // a later pass converges it.
        fail++
        return
      }
      const currentBit = ops.getBit(handle, 0)
      if (currentBit < 0) {
        // get_bit error (negative status) — unknown current value; don't
        // write blind, don't claim verified.
        fail++
        return
      }
      if (!boolMismatch(currentBit, job.value)) {
        verified++
        return
      }

      ops.setInt8(handle, 0, job.value)
      const writeSt = await ops.writeTagAsync(handle, 2000)
      if (writeSt === PlcTagStatus.PLCTAG_STATUS_OK) {
        ok++
      } else {
        fail++
      }
    } catch {
      fail++
    } finally {
      // Unlike the old sync create, a FAILED async create can still hold a
      // live handle — always destroy non-negative handles.
      if (handle >= 0) {
        try { ops.destroy(handle) } catch { /* ignore */ }
      }
    }
  }

  // ── Worker pool: shared cursor, N workers, stop-on-abort ────────
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      if (abortedAt != null) return // circuit breaker tripped — stop taking work
      // PLC dropped mid-pass (power cut, download started) — stop. The
      // 'initialized' trigger on reconnect redoes the full pass.
      if (!isConnected()) {
        disconnected = true
        return
      }
      const job = jobs[cursor++]
      await runJob(job)
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, jobs.length || 1))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return { ok, verified, fail, skipped, skippedFaulted, abortedAt, disconnected }
}

/**
 * One convergence pass for a REMOTE (gateway-owned) MCM: read every earned
 * flag through the gateway's typed-batch endpoint, compare against L2 truth,
 * write back ONLY the mismatches. Mirrors batchWriteFlags' semantics and
 * counters; the gateway executes the CIP traffic with its own non-blocking
 * sweeps, so neither the app's nor the gateway's event loop parks.
 *
 * Differences from the embedded pass (documented, deliberate):
 *  - No ConnectionFaulted pre-skip: the app has no per-device fault cache for
 *    remote MCMs. A faulted device's reads simply fail in the batch result
 *    and are counted; the next trigger retries. The gateway's batch sweep
 *    bounds the cost (one timeout window for the whole batch, not per tag).
 *  - "Tag not in the program" verdicts are detected from the result error
 *    text and cached in the same knownMissingTags set (keyed by PLC ip).
 */
async function runRemoteTargetPass(
  subsystemId: string,
  ip: string,
  devices: ValidatedDevice[],
): Promise<BatchResult> {
  const { readTypedTagsForMcm, writeTypedTagsForMcm } = await import('@/lib/mcm-registry')

  let ok = 0
  let verified = 0
  let fail = 0
  let skipped = 0

  const jobs: FlagJob[] = []
  for (let deviceIdx = 0; deviceIdx < devices.length; deviceIdx++) {
    for (const { field, value } of devices[deviceIdx].writes) {
      const tagPath = `CBT_${devices[deviceIdx].deviceName}.CTRL.CMD.${field}`
      const cacheKey = `${ip}::${tagPath}`
      if (knownMissingTags.has(cacheKey)) {
        skipped++
        continue
      }
      jobs.push({ deviceIdx, tagPath, cacheKey, value })
    }
  }
  if (jobs.length === 0) {
    return { ok, verified, fail, skipped, skippedFaulted: 0, abortedAt: null, disconnected: false }
  }

  const readBatch = await readTypedTagsForMcm(
    subsystemId,
    jobs.map((j) => ({ name: j.tagPath, dataType: 'BOOL' as const })),
  )
  if (!readBatch.connected) {
    return { ok, verified, fail: jobs.length, skipped, skippedFaulted: 0, abortedAt: null, disconnected: true }
  }

  const writes: Array<{ name: string; value: number; dataType: 'BOOL' }> = []
  for (let i = 0; i < jobs.length; i++) {
    const r = readBatch.results[i]
    if (!r || !r.success) {
      // Cache ONLY definitive "not in the program" verdicts — transient
      // failures must retry (same rule as the embedded pass). Match not-found
      // AND bad-parameter/unsupported: a CMD member absent from the AOI (e.g.
      // Tracking_Finished) answers "bad parameter", not "not found", and must
      // be cached too or it re-spams createTag every pass (MCM04 2026-07-16).
      if (r?.error && /not.?found|bad.?param|unsupported/i.test(r.error)) {
        knownMissingTags.add(jobs[i].cacheKey)
        skipped++
      } else {
        fail++
      }
      continue
    }
    const currentSet = r.value === true || r.value === 1
    if (currentSet === (jobs[i].value !== 0)) {
      verified++
    } else {
      writes.push({ name: jobs[i].tagPath, value: jobs[i].value, dataType: 'BOOL' })
    }
  }

  if (writes.length > 0) {
    const writeBatch = await writeTypedTagsForMcm(subsystemId, writes)
    if (!writeBatch.connected) {
      fail += writes.length
      return { ok, verified, fail, skipped, skippedFaulted: 0, abortedAt: null, disconnected: true }
    }
    for (const w of writeBatch.results) {
      if (w.success) ok++
      else fail++
    }
  }

  return { ok, verified, fail, skipped, skippedFaulted: 0, abortedAt: null, disconnected: false }
}

// ── Untrack retraction (edge-triggered) ────────────────────────────
//
// WHY: nothing in this tool EVER un-latched the PLC. `Invalidate_Tracking_
// Finished` was written by NO code path — it existed only in the read
// allowlist. So an untrack on the cloud merely stopped future assertion and
// left the controller latched forever, with the keypad still locked out.
//
// GROUND TRUTH — read directly out of AOI_IOCT_BELT_TRACKING_AOI222.L5X
// (do NOT re-derive from code comments; several in this repo are wrong):
//
//   rung 3: XIC(Valid_HP)[ XIC(CTRL.CMD.Tracking_Finished) ONS OTL(Tracking_Finished),
//                          XIC(CTRL.CMD.Invalidate_Tracking_Finished) OTU(Tracking_Finished),
//                          XIO(Tracking_Finished)[ XIC(Flip_Polarity) OTL(Reverse_Polarity),
//                                                  XIO(Flip_Polarity) OTU(Reverse_Polarity) ],
//                          XIC(Tracking_Finished)[ XIC(CTRL.CMD.Reverse_Polarity) ONS OTL(Reverse_Polarity),
//                                                  XIC(CTRL.CMD.Normal_Polarity) OTU(Reverse_Polarity) ] ]
//   rung 6: [ XIC(Tracking_Finished) XIC(CTRL.CMD.Valid_Direction) ONS OTL(Valid_Direction),
//             XIC(CTRL.CMD.Invalidate_Direction) OTU(Valid_Direction), ... ]
//   rung 7: [ XIO(Reverse_Polarity) OTE(Drive_Outputs.DirectionCmd_0),
//             XIC(Reverse_Polarity) OTE(Drive_Outputs.DirectionCmd_1) ]
//   rung 9: XIC(Track_Belt) OTE(CTRL.STS.Belt_Tracking_ON),
//           MOVE(Drive_Outputs.CommandedVelocity, CTRL.STS.RVS)
//
// Four consequences drive this implementation:
//
//  1. The WHOLE of rung 3 is gated on Valid_HP. With Valid_HP=0 the invalidate
//     SILENTLY DOES NOTHING — so we verify STS.Valid_HP=1 first and skip if not.
//     (Note: rung 6's Invalidate_Direction branch is NOT under that XIC, so it
//     works either way; we still gate the whole sequence to keep it atomic.)
//  2. Valid_Direction does NOT drop when Tracking_Finished drops — rung 6 needs
//     its OWN pulse. Two writes, not one.
//  3. CMD.Normal_Polarity is only honoured on the `XIC(Tracking_Finished)`
//     branch of rung 3 — i.e. ONLY WHILE THE LATCH IS STILL SET. And rung 7 is
//     UNCONDITIONAL, so unlatching Tracking_Finished hands Reverse_Polarity back
//     to the keypad's Flip_Polarity and can flip DirectionCmd. On a MOVING belt
//     that is a DIRECTION REVERSAL with Start still asserted. Hence the strict
//     order Normal_Polarity → Invalidate_Direction → Invalidate_Tracking_Finished,
//     and hence retraction is DEFERRED until the drive is proven stopped.
//  4. NEVER send Invalidate_HP before these — it drops Valid_HP and makes the
//     tracking latch permanently unclearable (see point 1).
//
// `Stop_Belt_Tracking` is a DEAD TAG — declared in the CMD UDT, used in ZERO
// rungs of the AOI. It is never written here.
//
// Two AOI revisions are in the fleet with different STS member names:
// AOI222 exposes `STS.Belt_Tracking_ON`, the older UDT exposes `STS.Track_Belt`.
// Both are probed; a missing member must not throw.
//
// `Tracking_Finished` is NOT exposed in STS on EITHER revision, so the latch
// state cannot be read back. That is exactly why the tracked→untracked EDGE
// must be persisted locally rather than recomputed from the controller.

/**
 * The retraction write order. NOT alphabetical, NOT arbitrary — see point 3
 * above. Normal_Polarity must land while Tracking_Finished is still latched
 * (rung 3's XIC(Tracking_Finished) branch), and the tracking latch must drop
 * LAST so the belt never changes direction under an asserted Start.
 */
export const RETRACTION_WRITE_ORDER: readonly string[] = [
  'Normal_Polarity',
  'Invalidate_Direction',
  'Invalidate_Tracking_Finished',
]

/** STS member names for "belt tracking mode is running", newest revision first. */
export const BELT_TRACKING_ON_MEMBERS: readonly string[] = ['Belt_Tracking_ON', 'Track_Belt']

/**
 * |STS.RVS| below this counts as stopped. STS.RVS is a MOVE of
 * Drive_Outputs.CommandedVelocity (rung 9) — commanded, not measured — so it
 * sits at exactly 0.0 when idle; the epsilon only absorbs float noise.
 */
export const RVS_STOPPED_EPSILON = 0.5

/** STS snapshot the retraction decision is made from. `null` = unreadable. */
export interface RetractionSts {
  /** STS.Valid_HP, 0/1, or null when unreadable. */
  validHp: number | null
  /** STS.Belt_Tracking_ON or STS.Track_Belt, 0/1, or null when NEITHER exists. */
  beltTrackingOn: number | null
  /** STS.RVS (REAL), or null when unreadable. */
  rvs: number | null
}

export type RetractionAction = 'retract' | 'defer' | 'skip'

export interface RetractionPlan {
  action: RetractionAction
  reason: string
}

/**
 * PURE decision: may we retract this device's tracking latch right now?
 *
 *   skip    — the write provably cannot work (Valid_HP=0 → rung 3 dead). Do not
 *             retry blindly; log it.
 *   defer   — the drive is (or may be) moving, or we cannot PROVE it is stopped.
 *             Retraction stays pending and is retried on a later pass. We never
 *             force it: rung 7 is unconditional, so retracting under motion
 *             reverses a running belt.
 *   retract — Valid_HP=1, belt-tracking mode off, and commanded velocity ~0.
 *
 * "Cannot prove stopped" is deliberately DEFER, not retract. If neither STS
 * member exists, or RVS is unreadable, we have no evidence of a stopped drive
 * and the conservative answer is to wait.
 */
export function planRetraction(sts: RetractionSts): RetractionPlan {
  if (sts.validHp == null) {
    return { action: 'defer', reason: 'STS.Valid_HP unreadable — cannot confirm the invalidate rung is live' }
  }
  if (sts.validHp === 0) {
    return {
      action: 'skip',
      reason: 'STS.Valid_HP=0 — the whole of AOI rung 3 is gated on Valid_HP, so ' +
        'Invalidate_Tracking_Finished would silently do nothing',
    }
  }
  if (sts.beltTrackingOn == null) {
    return {
      action: 'defer',
      reason: 'neither STS.Belt_Tracking_ON nor STS.Track_Belt is readable — cannot prove the drive is stopped',
    }
  }
  if (sts.beltTrackingOn !== 0) {
    return { action: 'defer', reason: 'belt tracking is still RUNNING — retracting now would reverse a moving belt (AOI rung 7 is unconditional)' }
  }
  if (sts.rvs == null) {
    return { action: 'defer', reason: 'STS.RVS unreadable — cannot prove commanded velocity is zero' }
  }
  if (Math.abs(sts.rvs) >= RVS_STOPPED_EPSILON) {
    return { action: 'defer', reason: `STS.RVS=${sts.rvs} — drive still commanded to move` }
  }
  return { action: 'retract', reason: 'drive stopped (tracking off, RVS~0) and Valid_HP=1' }
}

/**
 * PURE edge computation for one pass.
 *
 * CRITICAL: this is EDGE-triggered on a real tracked→not-tracked transition,
 * NOT level-triggered on "the cell is empty". Level-triggering would fire an
 * invalidate pulse at every device that was simply NEVER tracked — most of the
 * fleet — on every reconnect and every 5-minute sweep.
 *
 * `prevTracked` is the durable set of devices this instance believes it has
 * latched on the controller. On the FIRST EVER pass it is null: we seed it from
 * the current truth and emit NO edges, so installing this build can never spray
 * invalidate pulses across a plant.
 *
 * A device re-tracked while a retraction was still pending is REMOVED from the
 * pending set — mech changed their mind, and the level-triggered assert path
 * will (re)latch it.
 */
export function computeRetractionEdges(
  prevTracked: Set<string> | null,
  nowTracked: Set<string>,
  pending: Set<string>,
): { nextTracked: Set<string>; nextPending: Set<string>; newlyUntracked: string[] } {
  // First run on this install: adopt current truth, emit nothing.
  if (prevTracked === null) {
    return { nextTracked: new Set(nowTracked), nextPending: new Set(pending), newlyUntracked: [] }
  }

  const newlyUntracked = Array.from(prevTracked)
    .filter(name => !nowTracked.has(name))
    .sort()

  const nextPending = new Set(pending)
  for (const name of newlyUntracked) nextPending.add(name)
  // Re-tracked → cancel any pending retraction for it.
  for (const name of Array.from(nowTracked)) nextPending.delete(name)

  return { nextTracked: new Set(nowTracked), nextPending, newlyUntracked }
}

// Durable edge state. Reuses the existing SyncMaintenanceFlags KV table
// (lib/db-sqlite.ts) rather than inventing a parallel store — the facts here are
// exactly what that table is for: durable, tool-scoped, must survive a restart.
// An in-memory set would lose the edge across a service restart and leave the
// controller latched forever, which is the bug being fixed.
const KV_TRACKED = 'vfd_belt_tracking_latched'   // JSON string[] — believed latched on the PLC
const KV_PENDING = 'vfd_belt_tracking_retract_pending' // JSON string[] — untracked, retraction owed

function kvReadSet(key: string): Set<string> | null {
  try {
    const row = db.prepare('SELECT Value FROM SyncMaintenanceFlags WHERE Key = ?').get(key) as
      | { Value: string | null } | undefined
    if (!row || row.Value == null) return null
    const parsed = JSON.parse(row.Value)
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : null
  } catch {
    return null
  }
}

function kvWriteSet(key: string, value: Set<string>): void {
  try {
    db.prepare(
      `INSERT INTO SyncMaintenanceFlags (Key, Value, UpdatedAt)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value, UpdatedAt = datetime('now')`,
    ).run(key, JSON.stringify(Array.from(value).sort()))
  } catch (err) {
    console.error(`[VfdValidationWriter] Failed to persist ${key}:`, err)
  }
}

/** PLC ops for retraction — superset of PlcWriteOps, injectable for tests. */
export interface PlcRetractOps extends PlcWriteOps {
  /** Read a REAL out of the tag buffer. */
  getFloat32: (handle: number, offset: number) => number
}

const realRetractOps: PlcRetractOps = { ...realOps, getFloat32: plc_tag_get_float32 }

/** Read one BOOL STS member. Returns null when the member doesn't exist. */
async function readStsBool(
  ops: PlcRetractOps,
  gateway: string,
  path: string,
  tagPath: string,
): Promise<number | null> {
  let handle = -1
  try {
    const created = await ops.createTagAsync({ gateway, path, name: tagPath, elemSize: 1, elemCount: 1 }, CREATE_TAG_TIMEOUT_MS)
    handle = created.handle
    if (created.status !== PlcTagStatus.PLCTAG_STATUS_OK) return null
    if (await ops.readTagAsync(handle, 2000) !== PlcTagStatus.PLCTAG_STATUS_OK) return null
    const bit = ops.getBit(handle, 0)
    return bit < 0 ? null : (bit === 0 ? 0 : 1)
  } catch {
    return null
  } finally {
    if (handle >= 0) { try { ops.destroy(handle) } catch { /* ignore */ } }
  }
}

/** Read STS.RVS (REAL). Returns null when unreadable. */
async function readStsReal(
  ops: PlcRetractOps,
  gateway: string,
  path: string,
  tagPath: string,
): Promise<number | null> {
  let handle = -1
  try {
    const created = await ops.createTagAsync({ gateway, path, name: tagPath, elemSize: 4, elemCount: 1 }, CREATE_TAG_TIMEOUT_MS)
    handle = created.handle
    if (created.status !== PlcTagStatus.PLCTAG_STATUS_OK) return null
    if (await ops.readTagAsync(handle, 2000) !== PlcTagStatus.PLCTAG_STATUS_OK) return null
    const v = ops.getFloat32(handle, 0)
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  } finally {
    if (handle >= 0) { try { ops.destroy(handle) } catch { /* ignore */ } }
  }
}

/**
 * Read the STS snapshot for a device, probing BOTH AOI revisions' member names
 * for the belt-tracking-on bit. A missing member yields null, never a throw.
 */
export async function readRetractionSts(
  ops: PlcRetractOps,
  gateway: string,
  path: string,
  deviceName: string,
): Promise<RetractionSts> {
  const base = `CBT_${deviceName}.CTRL.STS.`
  const validHp = await readStsBool(ops, gateway, path, `${base}Valid_HP`)

  let beltTrackingOn: number | null = null
  for (const member of BELT_TRACKING_ON_MEMBERS) {
    beltTrackingOn = await readStsBool(ops, gateway, path, `${base}${member}`)
    if (beltTrackingOn !== null) break
  }

  const rvs = await readStsReal(ops, gateway, path, `${base}RVS`)
  return { validHp, beltTrackingOn, rvs }
}

/** Write one CMD bit. Returns true on a confirmed successful write. */
async function writeCmdBit(
  ops: PlcRetractOps,
  gateway: string,
  path: string,
  tagPath: string,
  value: number,
): Promise<boolean> {
  let handle = -1
  try {
    const created = await ops.createTagAsync({ gateway, path, name: tagPath, elemSize: 1, elemCount: 1 }, CREATE_TAG_TIMEOUT_MS)
    handle = created.handle
    if (created.status !== PlcTagStatus.PLCTAG_STATUS_OK) return false
    // Read first so the buffer is valid before we mutate one byte of it —
    // same convention as the clear route and the convergence pass.
    if (await ops.readTagAsync(handle, 2000) !== PlcTagStatus.PLCTAG_STATUS_OK) return false
    if (ops.setInt8(handle, 0, value) !== PlcTagStatus.PLCTAG_STATUS_OK) return false
    return (await ops.writeTagAsync(handle, 2000)) === PlcTagStatus.PLCTAG_STATUS_OK
  } catch {
    return false
  } finally {
    if (handle >= 0) { try { ops.destroy(handle) } catch { /* ignore */ } }
  }
}

export interface RetractionOutcome {
  deviceName: string
  action: RetractionAction | 'failed'
  reason: string
  /** CMD fields successfully written, in the order they were issued. */
  written: string[]
}

/**
 * Retract ONE device's tracking latch on an FFI target.
 *
 * Sequence, strictly ordered and sequential (each await completes before the
 * next is issued) — see RETRACTION_WRITE_ORDER and the ground-truth block:
 *   1. CMD.Normal_Polarity = 1              (honoured only while still latched)
 *   2. CMD.Invalidate_Direction = 1         (rung 6 — its own pulse)
 *   3. CMD.Invalidate_Tracking_Finished = 1 (rung 3 — the latch, LAST)
 *
 * Invalidate_HP is NEVER sent. If any step fails the sequence ABORTS: dropping
 * the tracking latch without having restored Normal_Polarity first is precisely
 * the direction-flip we are avoiding.
 */
export async function retractDeviceOnFfi(
  ops: PlcRetractOps,
  gateway: string,
  path: string,
  deviceName: string,
): Promise<RetractionOutcome> {
  const sts = await readRetractionSts(ops, gateway, path, deviceName)
  const plan = planRetraction(sts)
  if (plan.action !== 'retract') {
    return { deviceName, action: plan.action, reason: plan.reason, written: [] }
  }

  const written: string[] = []
  for (const field of RETRACTION_WRITE_ORDER) {
    const okWrite = await writeCmdBit(ops, gateway, path, `CBT_${deviceName}.CTRL.CMD.${field}`, 1)
    if (!okWrite) {
      return {
        deviceName,
        action: 'failed',
        reason: `write of CMD.${field} failed after [${written.join(', ') || 'none'}] — ` +
          'sequence ABORTED so the tracking latch is not dropped with polarity unrestored',
        written,
      }
    }
    written.push(field)
  }
  return { deviceName, action: 'retract', reason: plan.reason, written }
}

/**
 * Retract ONE device's tracking latch on a REMOTE (plc-gateway) target.
 * Same guards and the same ordering; the three writes are issued as three
 * SEPARATE sequential batches so the gateway cannot reorder them.
 */
export async function retractDeviceOnRemote(
  subsystemId: string,
  deviceName: string,
  io: {
    readTyped: (sid: string, reads: Array<{ name: string; dataType: 'BOOL' | 'REAL' }>) => Promise<{
      connected: boolean
      results: Array<{ success: boolean; value?: unknown; error?: string }>
    }>
    writeTyped: (sid: string, writes: Array<{ name: string; value: number; dataType: 'BOOL' }>) => Promise<{
      connected: boolean
      results: Array<{ success: boolean; error?: string }>
    }>
  },
): Promise<RetractionOutcome> {
  const base = `CBT_${deviceName}.CTRL.STS.`
  const reads: Array<{ name: string; dataType: 'BOOL' | 'REAL' }> = [
    { name: `${base}Valid_HP`, dataType: 'BOOL' },
    ...BELT_TRACKING_ON_MEMBERS.map(m => ({ name: `${base}${m}`, dataType: 'BOOL' as const })),
    { name: `${base}RVS`, dataType: 'REAL' },
  ]
  const batch = await io.readTyped(subsystemId, reads)
  if (!batch.connected) {
    return { deviceName, action: 'defer', reason: 'MCM not connected', written: [] }
  }

  const bool = (i: number): number | null => {
    const r = batch.results[i]
    if (!r?.success) return null
    return r.value === true || r.value === 1 ? 1 : 0
  }
  const validHp = bool(0)
  let beltTrackingOn: number | null = null
  for (let i = 0; i < BELT_TRACKING_ON_MEMBERS.length; i++) {
    const v = bool(1 + i)
    if (v !== null) { beltTrackingOn = v; break }
  }
  const rvsRes = batch.results[1 + BELT_TRACKING_ON_MEMBERS.length]
  const rvs = rvsRes?.success && typeof rvsRes.value === 'number' ? rvsRes.value : null

  const plan = planRetraction({ validHp, beltTrackingOn, rvs })
  if (plan.action !== 'retract') {
    return { deviceName, action: plan.action, reason: plan.reason, written: [] }
  }

  const written: string[] = []
  for (const field of RETRACTION_WRITE_ORDER) {
    const w = await io.writeTyped(subsystemId, [
      { name: `CBT_${deviceName}.CTRL.CMD.${field}`, value: 1, dataType: 'BOOL' },
    ])
    if (!w.connected || !w.results[0]?.success) {
      return {
        deviceName,
        action: 'failed',
        reason: `write of CMD.${field} failed after [${written.join(', ') || 'none'}] — sequence ABORTED`,
        written,
      }
    }
    written.push(field)
  }
  return { deviceName, action: 'retract', reason: plan.reason, written }
}

/** Devices whose local 'Belt Tracked' cell currently reads tracked. */
function trackedDeviceNames(): Set<string> {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT d.DeviceName AS deviceName
      FROM L2Devices d
      JOIN L2Sheets s   ON s.id = d.SheetId
      JOIN L2Columns c  ON c.SheetId = d.SheetId AND c.Name = '${BELT_TRACKED_COLUMN_NAME}'
      JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
      WHERE LOWER(TRIM(COALESCE(cv.Value, ''))) = '${BELT_TRACKED_VALUE.toLowerCase()}'
        AND (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
    `).all() as Array<{ deviceName: string }>
    return new Set(rows.map(r => r.deviceName))
  } catch (err) {
    console.error('[VfdValidationWriter] tracked-device query failed:', err)
    // Query failure must NOT look like "everything got untracked" — returning an
    // empty set would manufacture an edge for every latched device. Signal
    // failure by throwing to the caller's guard instead.
    throw err
  }
}

// Throttle repeated defer/skip logging per device.
const lastRetractLogMs = new Map<string, number>()
const RETRACT_LOG_INTERVAL_MS = 15 * 60_000

function logRetractOnce(deviceName: string, message: string, nowMs: number): void {
  const last = lastRetractLogMs.get(deviceName) ?? 0
  if (nowMs - last < RETRACT_LOG_INTERVAL_MS) return
  lastRetractLogMs.set(deviceName, nowMs)
  console.warn(message)
}

/** One controller this pass writes to. */
export interface WriteTarget {
  /** ffi = in-process PlcClient (embedded); remote = via plc-gateway typed batches. */
  kind: 'ffi' | 'remote'
  label: string
  ip: string
  path: string
  /** Owning subsystem. Required for remote (gateway route key); also set on
   *  embedded MCM targets so the belt-tracking freshness gate can look up that
   *  subsystem's delta cursor. Undefined only on a legacy singleton with no
   *  configured subsystem. */
  subsystemId?: string
  isConnected: () => boolean
  readTagCached: (name: string) => boolean | null
  devices: ValidatedDevice[]
}

/**
 * Edge-triggered retraction pass: find devices that went tracked→untracked
 * since the last pass and un-latch them on the controller that owns them.
 *
 * Freshness applies here too, but INVERTED in spirit: we only ACT on an
 * untrack for a subsystem whose truth we have recently confirmed. Retracting
 * from a stale local cell would be the mirror-image of the original bug — an
 * out-of-contact instance clearing a latch another instance legitimately set.
 * A stale subsystem's edges stay pending and are retracted once contact
 * returns; nothing is lost, because the pending set is durable.
 */
export async function runRetractionPass(
  targets: WriteTarget[],
  freshBySubsystem: Map<string, boolean>,
): Promise<RetractionOutcome[]> {
  // If the tracked-device query fails we must NOT proceed: an empty result
  // would look like "the whole plant got untracked" and spray invalidates.
  const nowTracked = trackedDeviceNames()

  const prevTracked = kvReadSet(KV_TRACKED)
  const pending = kvReadSet(KV_PENDING) ?? new Set<string>()
  const { nextTracked, nextPending, newlyUntracked } = computeRetractionEdges(prevTracked, nowTracked, pending)

  if (prevTracked === null) {
    // First run on this install: adopt current truth, emit NOTHING. This is the
    // guard that stops a fresh deploy from pulsing invalidate at every device
    // that was simply never tracked.
    kvWriteSet(KV_TRACKED, nextTracked)
    kvWriteSet(KV_PENDING, nextPending)
    console.log(
      `[VfdValidationWriter] Retraction baseline seeded: ${nextTracked.size} device(s) recorded as ` +
      'belt-tracked. No retraction issued (edge state had never been persisted).',
    )
    return []
  }

  kvWriteSet(KV_TRACKED, nextTracked)
  kvWriteSet(KV_PENDING, nextPending)
  if (newlyUntracked.length > 0) {
    console.log(
      `[VfdValidationWriter] Belt-tracking UNTRACK edge on ${newlyUntracked.length} device(s): ` +
      `${newlyUntracked.join(', ')} — retraction owed.`,
    )
  }
  if (nextPending.size === 0) return []

  // Route each pending device to the target that owns it.
  const targetByDevice = new Map<string, WriteTarget>()
  for (const target of targets) {
    for (const d of target.devices) targetByDevice.set(d.deviceName, target)
  }

  const now = Date.now()
  const outcomes: RetractionOutcome[] = []
  const stillPending = new Set(nextPending)

  for (const deviceName of Array.from(nextPending).sort()) {
    const target = targetByDevice.get(deviceName)
    if (!target) {
      // Owning controller not connected (or the device no longer has any
      // earned flags, so it isn't in a target's device list). Stay pending.
      continue
    }
    const key = target.subsystemId ?? 'active'
    if (freshBySubsystem.get(key) === false) {
      logRetractOnce(
        deviceName,
        `[VfdValidationWriter] Retraction of ${deviceName} DEFERRED: subsystem ${key} is not ` +
        'cloud-confirmed, so the untrack may itself be stale local state. Stays pending.',
        now,
      )
      continue
    }

    let outcome: RetractionOutcome
    if (target.kind === 'remote') {
      const { readTypedTagsForMcm, writeTypedTagsForMcm } = await import('@/lib/mcm-registry')
      outcome = await retractDeviceOnRemote(target.subsystemId!, deviceName, {
        readTyped: (sid, reads) => readTypedTagsForMcm(sid, reads as any) as any,
        writeTyped: (sid, writes) => writeTypedTagsForMcm(sid, writes as any) as any,
      })
    } else {
      if (!target.isConnected()) continue
      outcome = await retractDeviceOnFfi(realRetractOps, target.ip, target.path, deviceName)
    }
    outcomes.push(outcome)

    if (outcome.action === 'retract') {
      // Only a COMPLETED sequence clears the debt. A partial/failed sequence
      // stays pending so the next pass finishes the job.
      stillPending.delete(deviceName)
      console.log(
        `[VfdValidationWriter] RETRACTED belt tracking on ${deviceName} (${target.label}): ` +
        `wrote ${outcome.written.join(' → ')} — ${outcome.reason}`,
      )
    } else if (outcome.action === 'skip') {
      // Provably impossible (Valid_HP=0). Drop the debt — retrying forever
      // would just burn CIP slots — but say so loudly.
      stillPending.delete(deviceName)
      console.warn(
        `[VfdValidationWriter] Retraction of ${deviceName} SKIPPED: ${outcome.reason}. ` +
        'The tracking latch (if set) must be cleared manually or by re-validating HP first.',
      )
    } else {
      logRetractOnce(
        deviceName,
        `[VfdValidationWriter] Retraction of ${deviceName} ${outcome.action.toUpperCase()}: ` +
        `${outcome.reason}. Stays pending, will retry.`,
        now,
      )
    }
  }

  if (stillPending.size !== nextPending.size) kvWriteSet(KV_PENDING, stillPending)
  return outcomes
}

// ── Local-control restore (LEVEL-based) ────────────────────────────
//
// WHAT MECH ACTUALLY NEEDS. Mechanics run the drive from the VFD keypad:
//   F1              start / stop
//   F0 + F2, held 5 s   reverse direction
//   F0 / F2         speed trim
// In AOI_IOCT_BELT_TRACKING_AOI222.L5X the rungs that implement those are
// rung 2 (keypad direction toggle), rung 4 (keypad speed) and rung 5 (F1
// start/stop via Track_Belt) — and ALL THREE are gated `XIC(Valid_HP)`, as is
// the whole of rung 3. So:
//
//     Valid_HP = 1 is the MASTER ENABLE for every local control.
//     A belt with Valid_HP=0 has a DEAD KEYPAD: the mechanic can neither start
//     it nor change its direction.
//
// And rung 3's `XIO(Tracking_Finished)[XIC(Flip_Polarity) OTL(Reverse_Polarity),
// XIO(Flip_Polarity) OTU(Reverse_Polarity)]` means the keypad only owns
// DIRECTION while Tracking_Finished is CLEAR.
//
// Hence, for an untracked belt, "hand control back to the mechanics" is three
// bits, in this order (LOCAL_CONTROL_WRITE_ORDER):
//   1. STS.Valid_Map  must be 1 — else pulse CMD.Valid_Map.
//      rung 1: `XIC(Check_Allowed) XIC(CMD.Valid_Map) ONS OTL(Valid_Map)`, so
//      this needs STS.Check_Allowed=1. Check_Allowed low means the drive's
//      comms are faulted / it is not in RunMode — we log and SKIP rather than
//      fight the controller.
//   2. STS.Valid_HP   must be 1 — else pulse CMD.Valid_HP.
//      rung 1: `XIC(Valid_Map) XIC(CMD.Valid_HP) ONS OTL(Valid_HP)` — Valid_Map
//      must be LATCHED FIRST, which is why the writes are strictly ordered and
//      each is confirmed before the next is issued. (Both landing in one scan
//      is also safe: rung 1's Valid_Map OTL executes before the Valid_HP branch
//      of the same rung. The ordering is belt-and-braces.)
//   3. CMD.Invalidate_Tracking_Finished — rung 3's OTU, which hands polarity
//      back to the keypad.
//
// NEVER `Invalidate_HP` or `Invalidate_Map` from this path: those are exactly
// what DISABLE the keypad. `Stop_Belt_Tracking` is a dead tag (0 of 11 rungs).
//
// WHY LEVEL, NOT EDGE (this is the fix over 948c70e):
// The edge-triggered retraction only fires on a real tracked→untracked
// transition recorded by THIS instance. If Tracking_Finished reappears from any
// other source — the wizard re-asserting, one of the other three tool instances
// sharing MCM15, a state that predates the durable baseline, or a manual change
// in Studio — the edge never fires and the belt stays locked out forever. So we
// also reconcile on STATE: every sweep, every device whose 'Belt Tracked' cell
// is empty gets its local-control bits verified and, where wrong, corrected.
//
// This is only safe because of the shape of the writes:
//   - Valid_Map / Valid_HP are READ BACK from STS first, so once correct they
//     produce ZERO writes. Self-converging.
//   - Invalidate_Tracking_Finished is an OTU. Pulsing it when the latch is
//     already clear is a genuine no-op in the ladder. That is what makes
//     level-based reconciliation of an UNREADABLE latch safe at all.
//     (`Tracking_Finished` and `Flip_Polarity` are LocalTags with
//     ExternalAccess="None" — we can never confirm the latch. Design for that.)
//
// SCOPE: only devices on sheets that actually DEFINE a 'Belt Tracked' column.
// On a legacy template there is no notion of tracking, every device would read
// as "untracked", and flagsForDevice() still asserts Valid_Direction there — we
// would be pulsing invalidates at the entire legacy fleet forever and fighting
// our own assert pass. Legacy sheets are left alone.

/**
 * Bits written to hand local control back, in ladder-mandated order. Only ever
 * written as 1 — rung 8's `FLL(0,CTRL.CMD,1)` runs every scan, so every CMD
 * write is a self-clearing one-shot pulse. Writing a 0 would be meaningless.
 */
export const LOCAL_CONTROL_WRITE_ORDER: readonly string[] = [
  'Valid_Map',
  'Valid_HP',
  'Invalidate_Tracking_Finished',
]

/** STS snapshot the local-control decision is made from. `null` = unreadable. */
export interface LocalControlSts {
  /** STS.Check_Allowed — the AOI's own permissive for latching Valid_Map. */
  checkAllowed: number | null
  /** STS.Valid_Map, 0/1, or null when unreadable. */
  validMap: number | null
  /** STS.Valid_HP, 0/1, or null when unreadable. THE master keypad enable. */
  validHp: number | null
  /** STS.Belt_Tracking_ON or STS.Track_Belt, 0/1, or null when NEITHER exists. */
  beltTrackingOn: number | null
  /** STS.RVS (REAL), or null when unreadable. */
  rvs: number | null
}

export type LocalControlAction = 'restore' | 'defer' | 'skip'

export interface LocalControlPlan {
  action: LocalControlAction
  /** Subset of LOCAL_CONTROL_WRITE_ORDER to issue, in order. */
  writes: string[]
  reason: string
}

/**
 * PURE decision: what must we write to give this untracked belt's keypad back?
 *
 *   defer     — the drive is (or may be) moving, or STS is unreadable. Never
 *               proceed on unprovable stopped-ness.
 *   skip      — Check_Allowed=0: the drive's comms are faulted, Valid_Map
 *               cannot latch, and without Valid_Map there is no Valid_HP and no
 *               live rung 3. Log it; do not fight the controller.
 *   restore   — issue `writes`, in order.
 *
 * There is deliberately NO "already satisfied, nothing to do" verdict: even
 * when Valid_Map and Valid_HP both read 1 we still pulse the invalidate,
 * because Tracking_Finished is UNREADABLE and we can never know the keypad owns
 * direction. The rate limiter, not a verdict, is what stops that repeating.
 *
 * WHY THE MOTION GUARD COVERS EVERYTHING, not just the invalidate: rung 7
 * (`[XIO(Reverse_Polarity) OTE(DirectionCmd_0), XIC(Reverse_Polarity)
 * OTE(DirectionCmd_1)]`) is UNCONDITIONAL, so clearing Tracking_Finished on a
 * MOVING belt hands Reverse_Polarity to the keypad and can reverse the belt
 * under power. One rule — prove it is stopped, or do nothing — is easier to
 * audit than a per-write exemption, and enabling a keypad mid-motion is not
 * something we want to be clever about either.
 *
 * CAVEAT worth stating out loud: STS.RVS is a MOVE of
 * Drive_Outputs.CommandedVelocity (rung 9) — COMMANDED, not measured. It reads
 * 0.0 on a belt that is still COASTING to a stop after the command dropped. The
 * belt-tracking-off check is the primary evidence; RVS is corroboration only.
 */
export function planLocalControlRestore(sts: LocalControlSts): LocalControlPlan {
  if (sts.beltTrackingOn == null) {
    return {
      action: 'defer',
      writes: [],
      reason: 'neither STS.Belt_Tracking_ON nor STS.Track_Belt is readable — cannot prove the drive is stopped',
    }
  }
  if (sts.beltTrackingOn !== 0) {
    return {
      action: 'defer',
      writes: [],
      reason: 'belt tracking is still RUNNING — enabling local control / clearing the ' +
        'tracking latch now could reverse a moving belt (AOI rung 7 is unconditional)',
    }
  }
  if (sts.rvs == null) {
    return { action: 'defer', writes: [], reason: 'STS.RVS unreadable — cannot prove commanded velocity is zero' }
  }
  if (Math.abs(sts.rvs) >= RVS_STOPPED_EPSILON) {
    return { action: 'defer', writes: [], reason: `STS.RVS=${sts.rvs} — drive still commanded to move` }
  }

  if (sts.validHp == null) {
    return { action: 'defer', writes: [], reason: 'STS.Valid_HP unreadable — cannot tell whether the keypad is enabled' }
  }
  // Valid_Map is only load-bearing when we actually have to latch something.
  // If Valid_HP already reads 1 the keypad is live and Valid_Map must have
  // latched at some point, so an unreadable Valid_Map is not a blocker.
  if (sts.validMap == null && sts.validHp !== 1) {
    return { action: 'defer', writes: [], reason: 'STS.Valid_Map unreadable and Valid_HP is not set — no safe way to enable the keypad' }
  }

  const needMap = sts.validMap === 0
  const needHp = sts.validHp === 0
  if (needMap && sts.checkAllowed !== 1) {
    return {
      action: 'skip',
      writes: [],
      reason: sts.checkAllowed == null
        ? 'STS.Check_Allowed unreadable — rung 1 needs XIC(Check_Allowed) to latch Valid_Map'
        : 'STS.Check_Allowed=0 — the drive is comms-faulted / not in RunMode, so rung 1 ' +
          'cannot latch Valid_Map and no local control can be granted. Not fighting it.',
    }
  }

  const writes: string[] = []
  if (needMap) writes.push('Valid_Map')
  if (needHp) writes.push('Valid_HP')
  // ALWAYS, even when the keypad already looks enabled: Tracking_Finished is a
  // LocalTag with ExternalAccess="None", so we can never read it back to know
  // whether the keypad owns direction. It is an OTU — a redundant pulse costs
  // one CIP write and does nothing to the ladder.
  writes.push('Invalidate_Tracking_Finished')

  const enableNote = needHp
    ? 'keypad was DEAD (STS.Valid_HP=0) — restoring the master enable'
    : 'keypad already enabled; re-handing direction ownership only'
  return {
    action: 'restore',
    writes,
    reason: `drive stopped (tracking off, RVS~0); ${enableNote}`,
  }
}

// ── Rate limit / backoff ───────────────────────────────────────────
//
// The whole point of level-based reconciliation is that it runs EVERY sweep.
// Without a limiter that is one CIP pulse per untracked device every 5 minutes,
// forever, on a controller we share with three other tool instances — and we
// can never read Tracking_Finished back to know we are done.
//
// So the backoff is on the DEVICE EVALUATION, not just the write: a device that
// was fully handled is not even STS-probed again until it is due. Steady-state
// cost for an untracked fleet is therefore zero between windows.
//
//   handled (writes all confirmed) → next due in LOCAL_CONTROL_REASSERT_MS
//                                    (default 30 min)
//   defer / skip / write failure   → next due in LOCAL_CONTROL_RETRY_MS
//                                    (default 60 s, i.e. effectively the next
//                                    sweep — a belt that stops must get its
//                                    keypad back in minutes, not half an hour)
//
// The memo is IN-MEMORY ON PURPOSE. A restart or a program download changes
// what the controller holds (a download reinitialises the AOI's local tags AND
// drops Valid_Map/Valid_HP), so a durable memo could permanently suppress the
// very pulse the download made necessary. One extra pulse per device after a
// restart is the cheap side of that trade. It is also reset on PLC reconnect
// (see clearKnownMissingTags) so a post-download restore is immediate, not
// delayed by up to REASSERT_MS.

export const LOCAL_CONTROL_REASSERT_MS = (() => {
  const n = parseInt(process.env.VFD_LOCAL_CONTROL_REASSERT_MS || '', 10)
  return Number.isFinite(n) && n >= 60_000 ? n : 30 * 60_000
})()

export const LOCAL_CONTROL_RETRY_MS = (() => {
  const n = parseInt(process.env.VFD_LOCAL_CONTROL_RETRY_MS || '', 10)
  return Number.isFinite(n) && n >= 10_000 ? n : 60_000
})()

/** deviceName → epoch ms before which we will not touch it again. */
const localControlNextDueMs = new Map<string, number>()

/**
 * Forget every local-control backoff. Called on PLC (re)connect: a program
 * download drops Valid_Map/Valid_HP and reinitialises the tracking latch, so
 * every untracked belt must be re-evaluated at once rather than waiting out a
 * 30-minute window with a dead keypad.
 */
export function resetLocalControlBackoff(): void {
  localControlNextDueMs.clear()
}

/** PURE: may we touch this device now? */
export function isLocalControlDue(deviceName: string, nowMs: number): boolean {
  const due = localControlNextDueMs.get(deviceName)
  return due === undefined || nowMs >= due
}

/** Record the outcome and schedule the next evaluation. */
function noteLocalControlDone(deviceName: string, action: LocalControlAction | 'failed', nowMs: number): void {
  const backoff = action === 'restore' ? LOCAL_CONTROL_REASSERT_MS : LOCAL_CONTROL_RETRY_MS
  localControlNextDueMs.set(deviceName, nowMs + backoff)
}

/**
 * Read the STS snapshot needed for the local-control decision, probing BOTH AOI
 * revisions' names for the belt-tracking-on bit. A missing member yields null,
 * never a throw.
 */
export async function readLocalControlSts(
  ops: PlcRetractOps,
  gateway: string,
  path: string,
  deviceName: string,
): Promise<LocalControlSts> {
  const base = `CBT_${deviceName}.CTRL.STS.`
  const checkAllowed = await readStsBool(ops, gateway, path, `${base}Check_Allowed`)
  const validMap = await readStsBool(ops, gateway, path, `${base}Valid_Map`)
  const validHp = await readStsBool(ops, gateway, path, `${base}Valid_HP`)

  let beltTrackingOn: number | null = null
  for (const member of BELT_TRACKING_ON_MEMBERS) {
    beltTrackingOn = await readStsBool(ops, gateway, path, `${base}${member}`)
    if (beltTrackingOn !== null) break
  }

  const rvs = await readStsReal(ops, gateway, path, `${base}RVS`)
  return { checkAllowed, validMap, validHp, beltTrackingOn, rvs }
}

export interface LocalControlOutcome {
  deviceName: string
  action: LocalControlAction | 'failed'
  reason: string
  /** CMD fields successfully written, in the order they were issued. */
  written: string[]
}

/**
 * Hand local control back on ONE device, FFI target.
 *
 * Writes are strictly sequential — each confirmed before the next is issued —
 * because rung 1 latches Valid_HP only `XIC(Valid_Map)`. Aborts on the first
 * failure: pulsing Invalidate_Tracking_Finished when Valid_HP never latched is
 * a silent no-op (rung 3 is gated on Valid_HP), and we would rather report the
 * failure and retry than log a success we cannot verify.
 */
export async function restoreLocalControlOnFfi(
  ops: PlcRetractOps,
  gateway: string,
  path: string,
  deviceName: string,
): Promise<LocalControlOutcome> {
  const sts = await readLocalControlSts(ops, gateway, path, deviceName)
  const plan = planLocalControlRestore(sts)
  if (plan.action !== 'restore') {
    return { deviceName, action: plan.action, reason: plan.reason, written: [] }
  }

  const written: string[] = []
  for (const field of LOCAL_CONTROL_WRITE_ORDER) {
    if (!plan.writes.includes(field)) continue
    const okWrite = await writeCmdBit(ops, gateway, path, `CBT_${deviceName}.CTRL.CMD.${field}`, 1)
    if (!okWrite) {
      return {
        deviceName,
        action: 'failed',
        reason: `write of CMD.${field} failed after [${written.join(', ') || 'none'}] — ` +
          'sequence ABORTED; the keypad may still be disabled. Will retry.',
        written,
      }
    }
    written.push(field)
  }
  return { deviceName, action: 'restore', reason: plan.reason, written }
}

/**
 * Hand local control back on ONE device, REMOTE (plc-gateway) target. Same
 * guards, same ordering; each write is its own sequential batch so the gateway
 * cannot reorder them.
 */
export async function restoreLocalControlOnRemote(
  subsystemId: string,
  deviceName: string,
  io: {
    readTyped: (sid: string, reads: Array<{ name: string; dataType: 'BOOL' | 'REAL' }>) => Promise<{
      connected: boolean
      results: Array<{ success: boolean; value?: unknown; error?: string }>
    }>
    writeTyped: (sid: string, writes: Array<{ name: string; value: number; dataType: 'BOOL' }>) => Promise<{
      connected: boolean
      results: Array<{ success: boolean; error?: string }>
    }>
  },
): Promise<LocalControlOutcome> {
  const base = `CBT_${deviceName}.CTRL.STS.`
  const reads: Array<{ name: string; dataType: 'BOOL' | 'REAL' }> = [
    { name: `${base}Check_Allowed`, dataType: 'BOOL' },
    { name: `${base}Valid_Map`, dataType: 'BOOL' },
    { name: `${base}Valid_HP`, dataType: 'BOOL' },
    ...BELT_TRACKING_ON_MEMBERS.map(m => ({ name: `${base}${m}`, dataType: 'BOOL' as const })),
    { name: `${base}RVS`, dataType: 'REAL' },
  ]
  const batch = await io.readTyped(subsystemId, reads)
  if (!batch.connected) {
    return { deviceName, action: 'defer', reason: 'MCM not connected', written: [] }
  }

  const bool = (i: number): number | null => {
    const r = batch.results[i]
    if (!r?.success) return null
    return r.value === true || r.value === 1 ? 1 : 0
  }
  let beltTrackingOn: number | null = null
  for (let i = 0; i < BELT_TRACKING_ON_MEMBERS.length; i++) {
    const v = bool(3 + i)
    if (v !== null) { beltTrackingOn = v; break }
  }
  const rvsRes = batch.results[3 + BELT_TRACKING_ON_MEMBERS.length]
  const rvs = rvsRes?.success && typeof rvsRes.value === 'number' ? rvsRes.value : null

  const plan = planLocalControlRestore({
    checkAllowed: bool(0),
    validMap: bool(1),
    validHp: bool(2),
    beltTrackingOn,
    rvs,
  })
  if (plan.action !== 'restore') {
    return { deviceName, action: plan.action, reason: plan.reason, written: [] }
  }

  const written: string[] = []
  for (const field of LOCAL_CONTROL_WRITE_ORDER) {
    if (!plan.writes.includes(field)) continue
    const w = await io.writeTyped(subsystemId, [
      { name: `CBT_${deviceName}.CTRL.CMD.${field}`, value: 1, dataType: 'BOOL' },
    ])
    if (!w.connected || !w.results[0]?.success) {
      return {
        deviceName,
        action: 'failed',
        reason: `write of CMD.${field} failed after [${written.join(', ') || 'none'}] — sequence ABORTED`,
        written,
      }
    }
    written.push(field)
  }
  return { deviceName, action: 'restore', reason: plan.reason, written }
}

/**
 * Devices whose local 'Belt Tracked' cell is NOT 'Yes', restricted to sheets
 * that actually define the column (see SCOPE in the section header).
 *
 * LEFT JOIN on the cell so a device with no cell row at all — never touched by
 * anyone — still counts as untracked, which is the common case and precisely
 * the belt whose keypad must work.
 *
 * On query failure this returns an EMPTY set: doing nothing is the safe
 * failure. (Contrast trackedDeviceNames(), which must THROW on failure, because
 * there an empty result would manufacture an untrack edge for every device.)
 */
function untrackedDeviceNames(): Set<string> {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT d.DeviceName AS deviceName
      FROM L2Devices d
      JOIN L2Sheets s   ON s.id = d.SheetId
      JOIN L2Columns c  ON c.SheetId = d.SheetId AND c.Name = '${BELT_TRACKED_COLUMN_NAME}'
      LEFT JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
      WHERE (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
        AND LOWER(TRIM(COALESCE(cv.Value, ''))) <> '${BELT_TRACKED_VALUE.toLowerCase()}'
    `).all() as Array<{ deviceName: string }>
    return new Set(rows.map(r => r.deviceName))
  } catch (err) {
    console.error('[VfdValidationWriter] untracked-device query failed:', err)
    return new Set()
  }
}

/** Injectable per-device restore, so the pass is testable without a DLL. */
export interface LocalControlDeps {
  restoreOnFfi: (gateway: string, path: string, deviceName: string) => Promise<LocalControlOutcome>
  restoreOnRemote: (subsystemId: string, deviceName: string) => Promise<LocalControlOutcome>
}

const realLocalControlDeps: LocalControlDeps = {
  restoreOnFfi: (gateway, path, deviceName) =>
    restoreLocalControlOnFfi(realRetractOps, gateway, path, deviceName),
  restoreOnRemote: async (subsystemId, deviceName) => {
    const { readTypedTagsForMcm, writeTypedTagsForMcm } = await import('@/lib/mcm-registry')
    return restoreLocalControlOnRemote(subsystemId, deviceName, {
      readTyped: (sid, reads) => readTypedTagsForMcm(sid, reads as any) as any,
      writeTyped: (sid, writes) => writeTypedTagsForMcm(sid, writes as any) as any,
    })
  },
}

/**
 * Route a device to the controller that owns it: the registry MCM for its
 * subsystem, else the target that already lists it among its validated devices,
 * else the legacy active singleton. Undefined = no connected controller owns
 * it this pass; we simply do nothing (and do NOT burn its backoff).
 */
function routeLocalControlDevice(
  deviceName: string,
  targets: WriteTarget[],
  subsystemByDevice: Map<string, string>,
): WriteTarget | undefined {
  const owner = subsystemByDevice.get(deviceName.toUpperCase())
  if (owner !== undefined) {
    const byOwner = targets.find(t => t.subsystemId === owner)
    if (byOwner) return byOwner
  }
  const byDeviceList = targets.find(t => t.devices.some(d => d.deviceName === deviceName))
  if (byDeviceList) return byDeviceList
  return targets.find(t => t.label === 'active-plc')
}

/**
 * LEVEL-based reconciliation pass: for EVERY untracked belt, make sure the
 * mechanics' keypad actually works.
 *
 * Unlike runRetractionPass this holds no durable state and needs no edge — it
 * is pure "is the world how it should be right now". That is the point: an
 * edge-only retraction can never recover a Tracking_Finished latch that
 * reappeared from the wizard, a peer instance, a pre-baseline state, or a
 * manual Studio change.
 *
 * The freshness gate still applies. An instance that has not confirmed its L2
 * copy against the cloud recently does NOT act — its "untracked" may itself be
 * stale, and writing on a shared controller from stale truth is the original
 * MCM15 bug wearing a different hat. Silence stays the safe failure.
 */
export async function runLocalControlRestorePass(
  targets: WriteTarget[],
  freshBySubsystem: Map<string, boolean>,
  untracked: Set<string>,
  subsystemByDevice: Map<string, string>,
  nowMs: number = Date.now(),
  deps: LocalControlDeps = realLocalControlDeps,
): Promise<LocalControlOutcome[]> {
  // Drop backoff memos for devices that are no longer untracked, so a belt that
  // is tracked and later untracked again is acted on IMMEDIATELY rather than
  // inheriting a stale 30-minute window.
  for (const name of Array.from(localControlNextDueMs.keys())) {
    if (!untracked.has(name)) localControlNextDueMs.delete(name)
  }
  if (untracked.size === 0) return []

  const outcomes: LocalControlOutcome[] = []
  let restored = 0
  let enabled = 0
  let deferred = 0
  let skipped = 0

  for (const deviceName of Array.from(untracked).sort()) {
    if (!isLocalControlDue(deviceName, nowMs)) continue

    const target = routeLocalControlDevice(deviceName, targets, subsystemByDevice)
    // No connected controller owns this device this pass. Don't consume the
    // backoff — we never actually looked.
    if (!target) continue

    const key = target.subsystemId ?? 'active'
    // FAIL CLOSED: only an explicit `true` lets us write. A subsystem with no
    // verdict at all was never judged, and an unjudged instance is exactly the
    // one that must stay quiet. Don't burn the backoff either — we never looked.
    if (freshBySubsystem.get(key) !== true) continue

    let outcome: LocalControlOutcome
    try {
      if (target.kind === 'remote') {
        outcome = await deps.restoreOnRemote(target.subsystemId!, deviceName)
      } else {
        if (!target.isConnected()) continue
        outcome = await deps.restoreOnFfi(target.ip, target.path, deviceName)
      }
    } catch (err) {
      outcome = { deviceName, action: 'failed', reason: `restore threw: ${String(err)}`, written: [] }
    }
    outcomes.push(outcome)
    noteLocalControlDone(deviceName, outcome.action, nowMs)

    if (outcome.action === 'restore') {
      restored++
      if (outcome.written.includes('Valid_HP')) {
        enabled++
        console.log(
          `[VfdValidationWriter] LOCAL CONTROL RESTORED on ${deviceName} (${target.label}): ` +
          `keypad was disabled (STS.Valid_HP=0) on an UNTRACKED belt — wrote ` +
          `${outcome.written.join(' → ')}. F1 start/stop, F0+F2 reverse and speed trim are live again.`,
        )
      }
    } else if (outcome.action === 'skip') {
      skipped++
      logRetractOnce(
        `lc:${deviceName}`,
        `[VfdValidationWriter] Local-control restore SKIPPED for ${deviceName}: ${outcome.reason}`,
        nowMs,
      )
    } else if (outcome.action === 'defer') {
      deferred++
    } else {
      logRetractOnce(
        `lc:${deviceName}`,
        `[VfdValidationWriter] Local-control restore FAILED for ${deviceName}: ${outcome.reason}`,
        nowMs,
      )
    }
  }

  if (outcomes.length > 0) {
    console.log(
      `[VfdValidationWriter] Local-control reconcile: ${outcomes.length} untracked belt(s) evaluated, ` +
      `${restored} reconciled (${enabled} had a DEAD keypad), ${deferred} deferred (running/unreadable), ` +
      `${skipped} skipped (Check_Allowed low). ` +
      `Next evaluation in ${Math.round(LOCAL_CONTROL_REASSERT_MS / 60_000)} min ` +
      `(${Math.round(LOCAL_CONTROL_RETRY_MS / 1000)} s for deferred/failed).`,
    )
  }
  return outcomes
}

// ── Main sync function ─────────────────────────────────────────────

/**
 * Read L2 data and converge CMD validation flags for every validated VFD.
 *
 * Requires the PLC client to be connected.  `getPlcStatus` and `getPlcClient`
 * are imported lazily to avoid circular-dependency issues with
 * plc-client-manager (which imports us).
 *
 * `reason` is purely diagnostic — it lands in the "Sync done" log line so
 * field logs show WHY a pass ran (plc-reconnect / l2-change / safety-net).
 */
export async function syncValidationFlags(reason: string = 'manual'): Promise<void> {
  if (WRITER_DISABLED) return

  // Throttle: don't run more than once every MIN_SYNC_INTERVAL_MS
  const now = Date.now()
  if (now - lastSyncMs < MIN_SYNC_INTERVAL_MS) {
    pendingSync = true
    scheduleDeferredSync(lastSyncMs + MIN_SYNC_INTERVAL_MS - now)
    return
  }
  if (syncRunning) {
    pendingSync = true
    return
  }

  syncRunning = true
  lastSyncMs = now
  pendingSync = false

  // TTL-expire stale "tag not in program" verdicts before each cycle —
  // guarantees a download that never tripped a reconnect still gets every
  // tag re-attempted within KNOWN_MISSING_TTL_MS.
  expireKnownMissingTags()

  try {
    // Lazy import to break circular dep (plc-client-manager → us is fine,
    // but we also need to reach back into it for connection info).
    const { getPlcClient, getPlcStatus } = await import('@/lib/plc-client-manager')
    const { getConnectedEmbeddedMcms } = await import('@/lib/mcm-registry')

    // ── Write targets: the legacy singleton + every connected embedded MCM ──
    // The central tool holds N concurrent per-MCM PLC connections in the
    // registry; the legacy field tablet has only the singleton. Each target
    // gets its own convergence pass against its own controller — writing a
    // device's flags to a PLC that doesn't own it is at best wasted CIP
    // traffic and at worst a wrong-controller write.
    const targets: WriteTarget[] = []

    let singletonTarget: WriteTarget | null = null
    if (!PLC_REMOTE) {
      // The singleton would lazily LOAD libplctag into the app process —
      // forbidden in the split deployment (the gateway owns the library).
      try {
        const client = getPlcClient()
        const { connectionConfig } = getPlcStatus()
        if (client.isConnected && connectionConfig) {
          singletonTarget = {
            kind: 'ffi',
            label: 'active-plc',
            ip: connectionConfig.ip,
            path: connectionConfig.path,
            isConnected: () => client.isConnected,
            readTagCached: (name) => client.readTagCached(name),
            devices: [],
          }
          targets.push(singletonTarget)
        }
      } catch { /* singleton not initialized — registry-only deployment */ }
    }

    const mcmTargetById = new Map<string, WriteTarget>()
    if (PLC_REMOTE) {
      // Split deployment: connected MCMs come from the gateway-state cache;
      // flag convergence rides the gateway's typed-batch endpoints.
      const { listMcms } = await import('@/lib/mcm-registry')
      for (const mcm of listMcms()) {
        if (!mcm.connected) continue
        const target: WriteTarget = {
          kind: 'remote',
          label: `mcm-${mcm.subsystemId}`,
          ip: mcm.ip,
          path: mcm.path,
          subsystemId: mcm.subsystemId,
          isConnected: () => true, // batch results carry connectivity per call
          readTagCached: () => null, // no per-device fault cache app-side; see runRemoteTargetPass
          devices: [],
        }
        mcmTargetById.set(mcm.subsystemId, target)
        targets.push(target)
      }
    } else {
      for (const mcm of getConnectedEmbeddedMcms()) {
        // An MCM pointing at the same controller as the active singleton would
        // run every job twice — route its devices through the singleton pass.
        if (singletonTarget && mcm.ip === singletonTarget.ip && mcm.path === singletonTarget.path) {
          mcmTargetById.set(mcm.subsystemId, singletonTarget)
          continue
        }
        const target: WriteTarget = {
          kind: 'ffi',
          label: `mcm-${mcm.subsystemId}`,
          ip: mcm.ip,
          path: mcm.path,
          subsystemId: mcm.subsystemId,
          isConnected: () => mcm.client.isConnected,
          readTagCached: (name) => mcm.client.readTagCached(name),
          devices: [],
        }
        mcmTargetById.set(mcm.subsystemId, target)
        targets.push(target)
      }
    }

    if (targets.length === 0) {
      console.log('[VfdValidationWriter] Skipped: no PLC connected (neither active singleton nor registry MCMs)')
      return
    }

    const devices = getValidatedDevices()
    if (devices.length === 0) {
      console.log('[VfdValidationWriter] Skipped: no VFDs with commissioning progress found in L2')
      return
    }

    // ── Partition devices among targets ──────────────────────────────
    // Registry MCMs own the devices of their subsystem (deviceName →
    // subsystem via Ios.NetworkDeviceName). Everything else — unmapped
    // devices, or devices whose owning MCM isn't a connected registry
    // entry — keeps the legacy behavior and goes through the active
    // singleton PLC when one is connected.
    // Hoisted: the local-control reconcile pass routes UNTRACKED devices too,
    // and those may have no wizard progress at all (so they never appear in any
    // target's `devices` list) — it needs the same deviceName→subsystem map.
    let subsystemByDevice = new Map<string, string>()
    if (mcmTargetById.size === 0) {
      // Legacy single-PLC deployment: exact pre-multi-MCM behavior.
      singletonTarget!.devices = devices
    } else {
      subsystemByDevice = getDeviceSubsystemMap()
      let unrouted = 0
      for (const device of devices) {
        const owner = subsystemByDevice.get(device.deviceName.toUpperCase())
        const target = (owner !== undefined ? mcmTargetById.get(owner) : undefined) ?? singletonTarget
        if (target) target.devices.push(device)
        else unrouted++
      }
      if (unrouted > 0) {
        console.log(
          `[VfdValidationWriter] ${unrouted} device(s) not converged this pass — ` +
          'owning MCM not connected and no active singleton PLC to fall back to',
        )
      }
    }

    // ── Belt-tracking freshness gate (per subsystem) ─────────────────
    // Before ANY flag write: if this instance has not recently confirmed its
    // local 'Belt Tracked' truth against the cloud for a subsystem, strip the
    // belt-tracking-dependent flags from that subsystem's devices. Valid_Map /
    // Valid_HP are untouched. See the BELT_TRACKING_FRESHNESS_MS block for the
    // MCM15 incident this exists for.
    if (singletonTarget && singletonTarget.subsystemId === undefined) {
      // Legacy tablet: the singleton's subsystem comes from config.
      try {
        const cfg = await configService.getConfig()
        const sid = typeof cfg.subsystemId === 'number' ? cfg.subsystemId : parseInt(String(cfg.subsystemId), 10)
        if (Number.isFinite(sid) && sid > 0) singletonTarget.subsystemId = String(sid)
      } catch { /* no config — SSE liveness is then the only freshness leg */ }
    }

    const freshBySubsystem = new Map<string, boolean>()
    for (const target of targets) {
      // NOTE: judged for EVERY target, including ones with no validated
      // devices. The local-control reconcile pass acts on untracked belts that
      // may have zero wizard progress, so their controller still needs a
      // verdict — and that pass fails closed on a missing one.
      const key = target.subsystemId ?? 'active'
      const verdict = judgeBeltTrackingFreshness(await probeFreshness(key), Date.now())
      freshBySubsystem.set(key, verdict.fresh)
      if (verdict.fresh) continue

      let heldBack = 0
      for (const device of target.devices) {
        const gatedOut = stripBeltTrackingWrites(device.writes)
        if (gatedOut !== device.writes) {
          device.writes = gatedOut
          heldBack++
        }
      }
      if (heldBack > 0) logStaleOnce(key, verdict.reason, heldBack, Date.now())
    }

    // ── Untrack retraction (edge-triggered) ──────────────────────────
    // Runs BEFORE the assert pass so a device untracked this cycle is
    // retracted rather than re-asserted-then-retracted. Never throws out.
    try {
      await runRetractionPass(targets, freshBySubsystem)
    } catch (err) {
      console.error('[VfdValidationWriter] Retraction pass error (non-fatal):', err)
    }

    // ── Local-control restore (LEVEL-based) ──────────────────────────
    // Runs AFTER the edge retraction on purpose: the edge path's
    // CMD.Normal_Polarity is only honoured while Tracking_Finished is STILL
    // LATCHED (rung 3), so it must get its chance before this pass drops the
    // latch. Runs BEFORE the assert pass so an untracked belt is never
    // re-asserted-then-reconciled inside the same sweep.
    //
    // This is the level-triggered safety net the edge path cannot be: it does
    // not care HOW Tracking_Finished came to be set, only that this belt is
    // untracked and therefore its keypad must work.
    try {
      await runLocalControlRestorePass(
        targets,
        freshBySubsystem,
        untrackedDeviceNames(),
        subsystemByDevice.size > 0 ? subsystemByDevice : getDeviceSubsystemMap(),
        Date.now(),
      )
    } catch (err) {
      console.error('[VfdValidationWriter] Local-control restore pass error (non-fatal):', err)
    }

    // ── One convergence pass per target, sequential ──────────────────
    // Sequential on purpose: each pass already runs WRITE_CONCURRENCY
    // outstanding FFI ops; stacking passes across controllers would multiply
    // pressure on the shared FFI thread pool for little latency win (a
    // reconnect trigger typically only has real work on ONE controller —
    // the others verify-only in a few seconds).
    for (const target of targets) {
      if (target.devices.length === 0) continue

      // Build the set of currently-faulted device names from this target's
      // cached tag state. This is the guard that prevents the writer from
      // flooding the CIP queue with doomed handle creations during a ring
      // break or controller hiccup. `:I.ConnectionFaulted` tags are loaded by
      // the network-status endpoint and refreshed continuously by the IO
      // reader's main poll loop (~75 ms), so the lookup is O(1) per device
      // and the data is at most a fraction of a second stale.
      const t0 = Date.now()
      let passResult: BatchResult
      if (target.kind === 'remote') {
        passResult = await runRemoteTargetPass(target.subsystemId!, target.ip, target.devices)
      } else {
        const faultedDevices = buildFaultedDeviceSet(target.readTagCached, target.devices)
        passResult = await batchWriteFlags(
          target.ip,
          target.path,
          target.devices,
          faultedDevices,
          target.isConnected,
        )
      }
      const { ok, verified, fail, skipped, skippedFaulted, abortedAt, disconnected } = passResult
      const elapsed = Date.now() - t0

      // Single structured log line per target per cycle. Critical for
      // diagnosing what the writer is doing in the field — operators / cloud
      // heartbeat can grep for `[VfdValidationWriter] Sync done` and see at a
      // glance whether the system is healthy (all ok), partially degraded
      // (some skipped-faulted), or short-circuited (aborted-mass-failure).
      const abortNote = abortedAt != null
        ? `, ABORTED at device ${abortedAt + 1}/${target.devices.length} after ${MAX_CONSECUTIVE_CREATE_FAILURES} consecutive createTag failures (CIP queue likely saturated; will retry next trigger)`
        : ''
      const disconnectNote = disconnected
        ? ', STOPPED — PLC disconnected mid-pass (reconnect trigger will redo the full pass)'
        : ''
      // Per-flag device counts — with per-flag assertion a device may earn only
      // some flags, so this shows how far the fleet has progressed at a glance.
      const mapN = target.devices.filter(d => d.writes.some(w => w.field === 'Valid_Map')).length
      const hpN = target.devices.filter(d => d.writes.some(w => w.field === 'Valid_HP')).length
      const dirN = target.devices.filter(d => d.writes.some(w => w.field === 'Valid_Direction')).length
      console.log(
        `[VfdValidationWriter] Sync done (${reason}, ${target.label}): ${target.devices.length} device(s) ` +
        `(${mapN} map, ${hpN} hp, ${dirN} dir), ` +
        `${ok} written, ${verified} already-correct, ${fail} failed, ` +
        `${skipped} skipped (known-missing), ` +
        `${skippedFaulted} skipped-faulted, ` +
        `${elapsed} ms${abortNote}${disconnectNote}`,
      )
    }

    // Direction-checked drives with no parseable Polarity stamp: their
    // Normal/Reverse_Polarity bits CANNOT be restored after a program
    // download — the recorded fact doesn't exist. Surface them loudly so
    // field logs / cloud heartbeat show exactly which belts are exposed.
    // Only direction-checked drives are flagged — identity/HP-only drives
    // legitimately have no polarity yet and are not "exposed". Computed over
    // ALL validated devices, not per target — exposure doesn't depend on
    // which controller the drive lives on.
    const noPolarity = devices
      .filter(d => d.hasDirection && parsePolarity(d.polarityRaw) === null)
      .map(d => d.deviceName)
      .sort()
    const noPolarityKey = noPolarity.join(',')
    if (noPolarityKey !== lastNoPolarityKey) {
      lastNoPolarityKey = noPolarityKey
      if (noPolarity.length > 0) {
        console.warn(
          `[VfdValidationWriter] ${noPolarity.length} direction-checked drive(s) have NO polarity stamp — ` +
          `their direction reverts to program-download default and cannot be auto-restored. ` +
          `Re-run the wizard bump test on: ${noPolarity.join(', ')}`,
        )
      } else {
        console.log('[VfdValidationWriter] All direction-checked drives now have a polarity stamp.')
      }
    }
  } catch (err) {
    console.error('[VfdValidationWriter] Sync error:', err)
  } finally {
    syncRunning = false
    // A trigger fired while this pass was running (throttle window or
    // syncRunning guard) — honor it shortly after, don't make it wait for
    // the safety net. With the old 10 s interval gone, THIS is the only
    // path that flushes coalesced requests.
    if (pendingSync) {
      pendingSync = false
      scheduleDeferredSync(MIN_SYNC_INTERVAL_MS)
    }
  }
}

// ── Deferred re-run (coalesced triggers) ───────────────────────────

let deferredTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Ensure a sync runs after `delayMs` — used to flush requests coalesced by
 * the throttle / running-pass guards. Single timer; earlier wins.
 */
function scheduleDeferredSync(delayMs: number): void {
  if (deferredTimer) return // one already pending — it will pick up the work
  deferredTimer = setTimeout(() => {
    deferredTimer = null
    syncValidationFlags('deferred').catch(err => {
      console.error('[VfdValidationWriter] Deferred sync error:', err)
    })
  }, Math.max(250, delayMs))
  // Don't hold the process open for a deferred flag write.
  ;(deferredTimer as any).unref?.()
}

// ── Public trigger (debounced) ─────────────────────────────────────

let triggerTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Request a validation sync.  Debounced — multiple rapid calls collapse
 * into one sync after a short delay.  Safe to call from API routes.
 */
export function triggerValidationSync(): void {
  if (triggerTimer) return // already scheduled
  triggerTimer = setTimeout(() => {
    triggerTimer = null
    syncValidationFlags('l2-change').catch(err => {
      console.error('[VfdValidationWriter] Triggered sync error:', err)
    })
  }, 2_000) // 2 s debounce — enough for the wizard to finish its burst of L2 writes
}

// ── Periodic safety-net ────────────────────────────────────────────
// NOT the primary restore path — reconnects trigger an immediate pass. This
// exists solely for divergence with NO connection event (e.g. a download
// over a CIP session that healed in place). Default every 5 min; each pass
// is read-mostly (writes only on actual divergence) and fully non-blocking.

if (!WRITER_DISABLED) {
  setInterval(() => {
    syncValidationFlags('safety-net').catch(err => {
      console.error('[VfdValidationWriter] Periodic sync error:', err)
    })
  }, SAFETY_NET_MS).unref?.()
} else {
  console.warn(
    '[VfdValidationWriter] DISABLED via VFD_VALIDATION_DISABLED=1 — ' +
    'validation/polarity flags will NOT be restored after PLC downloads/restarts',
  )
}
