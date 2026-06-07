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
  plc_tag_set_int8,
  PlcTagStatus,
  getStatusMessage,
  type PlcTagConfig,
} from '@/lib/plc'
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
  /** Raw "Polarity" L2 cell ("… · Normal|Inverter"), or null when unrecorded. */
  polarityRaw: string | null
}

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
 *   - Valid_Direction  when hasDirection
 *   - polarity pair    when hasDirection AND a polarity is recorded
 *
 * The polarity bits are taken verbatim from polarityFlagWrites() so they can
 * never drift from the polarity helper's definition. (vfd-polarity's
 * deviceFlagWrites() emits the same Valid_Map/Valid_HP/Valid_Direction + polarity
 * set all-or-nothing; here each flag is instead earned independently per step.)
 */
export function flagsForDevice(row: ValidationRow): FlagWrite[] {
  const writes: FlagWrite[] = []
  if (row.hasIdentity) writes.push({ field: 'Valid_Map', value: 1 })
  if (row.hasMotorHp && row.hasVfdHp) writes.push({ field: 'Valid_HP', value: 1 })
  if (row.hasDirection) {
    writes.push({ field: 'Valid_Direction', value: 1 })
    // Polarity bits only ride along with a stamped direction check.
    writes.push(...polarityFlagWrites(row.polarityRaw))
  }
  return writes
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
 * Forget every cached "tag not in program" verdict. MUST be called whenever
 * the PLC client (re)initializes: program downloads drop the connection, and
 * a download can add tags that were previously absent — or have answered
 * NOT_FOUND for tags that exist, while the transfer was in flight. Without
 * this, the writer permanently skipped those CMD flags until a tool restart,
 * leaving polarity/validation bits unrestored after a download (CDW5, June 2026).
 */
export function clearKnownMissingTags(reason: string): void {
  lastKnownMissingClearMs = Date.now()
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
  clearKnownMissingTags('periodic TTL expiry — re-probing tags previously reported missing')
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
function getValidatedDevices(): ValidatedDevice[] {
  try {
    const rows = db.prepare(`
      SELECT d.DeviceName AS deviceName, s.Name AS sheetName,
             MAX(CASE WHEN c.Name = 'Verify Identity'  AND TRIM(cv.Value) <> '' THEN 1 ELSE 0 END) AS hasIdentity,
             MAX(CASE WHEN c.Name = 'Motor HP (Field)' AND TRIM(cv.Value) <> '' THEN 1 ELSE 0 END) AS hasMotorHp,
             MAX(CASE WHEN c.Name = 'VFD HP (Field)'   AND TRIM(cv.Value) <> '' THEN 1 ELSE 0 END) AS hasVfdHp,
             MAX(CASE WHEN c.Name = 'Check Direction'  AND TRIM(cv.Value) <> '' AND LOWER(TRIM(cv.Value)) <> 'fail' THEN 1 ELSE 0 END) AS hasDirection,
             MAX(CASE WHEN c.Name = 'Polarity' THEN cv.Value END) AS polarityRaw
      FROM L2Devices d
      JOIN L2Sheets s   ON s.id = d.SheetId
      JOIN L2Columns c  ON c.SheetId = d.SheetId
      JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
      WHERE cv.Value IS NOT NULL AND cv.Value <> ''
        AND (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
      GROUP BY d.DeviceName, s.Name
      HAVING hasIdentity = 1 OR (hasMotorHp = 1 AND hasVfdHp = 1) OR hasDirection = 1
    `).all() as ValidationRow[]

    return rows.map(row => ({
      deviceName: row.deviceName,
      writes: flagsForDevice(row),
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
        // Cache ONLY definitive "not in the program" results. Transient
        // failures (timeout/busy/connection) must NOT be cached — the tag
        // may exist and should be retried once the PLC is responsive again.
        if (status === PlcTagStatus.PLCTAG_ERR_NOT_FOUND) {
          knownMissingTags.add(job.cacheKey)
          // PLCTAG_ERR_NOT_FOUND is a definitive answer from the
          // controller — don't count it as a "CIP queue is sick" signal.
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
      // failures must retry (same rule as the embedded pass).
      if (r?.error && /not.?found/i.test(r.error)) {
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
    interface WriteTarget {
      /** ffi = in-process PlcClient (embedded); remote = via plc-gateway typed batches. */
      kind: 'ffi' | 'remote'
      label: string
      ip: string
      path: string
      /** remote targets only — the gateway route key. */
      subsystemId?: string
      isConnected: () => boolean
      readTagCached: (name: string) => boolean | null
      devices: ValidatedDevice[]
    }
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
    if (mcmTargetById.size === 0) {
      // Legacy single-PLC deployment: exact pre-multi-MCM behavior.
      singletonTarget!.devices = devices
    } else {
      const subsystemByDevice = getDeviceSubsystemMap()
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
