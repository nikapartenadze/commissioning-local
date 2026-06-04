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
 * Performance: uses batch handle creation — all tags are created first, then a
 * tight read→set→write loop runs across all handles.  100 VFDs (300 tags) sync
 * in ~2-5 seconds, not minutes.
 *
 * Triggers:
 *   1. PLC 'initialized' event  → immediate sync of all validated VFDs
 *   2. L2 cell write / cloud pull → debounced re-sync
 *   3. Periodic safety-net      → every 10 s while PLC is connected
 *
 * Only writes "check" flags — never motor commands (Bump, Run_At_30_RVS, etc.).
 */

import { db } from '@/lib/db-sqlite'
import {
  createTag,
  plc_tag_read,
  plc_tag_write,
  plc_tag_destroy,
  plc_tag_set_int8,
  PlcTagStatus,
  getStatusMessage,
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

interface ValidatedDevice {
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

interface TagHandle {
  deviceName: string
  field: string
  tagPath: string
  handle: number
  /** Value to assert on this CMD bit (0 or 1). */
  value: number
}

// ── Throttle / state ───────────────────────────────────────────────

let lastSyncMs = 0
let syncRunning = false
let pendingSync = false
const MIN_SYNC_INTERVAL_MS = 5_000 // at most once per 5 s

// Tags that returned a definitive PLCTAG_ERR_NOT_FOUND, keyed `${gateway}::${tagPath}`.
// Once a CMD flag tag is known absent on a given PLC we stop re-creating it every
// sync. Cleared on every PLC (re)connect via clearKnownMissingTags() — a reconnect
// often follows a program download, after which the tag inventory may have changed
// (and a NOT_FOUND answered mid-download is not durable truth). Between connects it
// prevents the 10 s safety-net from spamming tens of thousands of failing createTag
// calls at the controller's CIP queue.
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

// Devices last reported as "validated but no polarity stamp" — used to log the
// list only when it CHANGES, not every 10 s cycle. These drives get
// Valid_Direction force-set while their Normal/Reverse_Polarity bits are left
// at whatever the last program download carried (typically 0/0) — i.e. they
// silently revert to default direction and the tool cannot restore them.
let lastNoPolarityKey = ''

// ── Batch write ────────────────────────────────────────────────────

/**
 * Batch-create all tag handles, then tight-loop read→set→write across them.
 *
 * Why batched?  libplctag reuses CIP sessions for tags on the same gateway+path.
 * Creating 300 handles takes ~1-2 s total (shared session setup).  The subsequent
 * read/write calls are ~5-15 ms each since the session is already open.
 * Total for 100 VFDs ≈ 2-5 seconds vs 60-90 s with per-tag create+destroy.
 */
function batchWriteFlags(
  gateway: string,
  path: string,
  devices: ValidatedDevice[],
  faultedDevices: Set<string>,
): { ok: number; fail: number; skipped: number; skippedFaulted: number; abortedAt: number | null } {
  const handles: TagHandle[] = []
  let ok = 0
  let fail = 0
  let skipped = 0
  // Devices we deliberately did NOT touch because they're currently in
  // ConnectionFaulted state. Separate counter from `skipped` (which counts
  // tags known absent from the PLC program) so the periodic log line lets
  // operators see "we held back 50 devices because the ring is broken" vs
  // "this PLC's program doesn't define these tags".
  let skippedFaulted = 0
  // If we trip the mass-failure circuit breaker, remember the device index
  // we stopped at so the log line is actionable.
  let abortedAt: number | null = null
  // Count of consecutive createTag failures across all devices in this
  // cycle. Resets on any success. When it hits MAX_CONSECUTIVE_CREATE_
  // FAILURES we stop creating new handles — Phase 2/3 still run for any
  // handles already created so we don't waste the work or leak them.
  let consecutiveCreateFailures = 0

  try {
    // ── Phase 1: create all handles ────────────────────────────────
    for (let deviceIdx = 0; deviceIdx < devices.length; deviceIdx++) {
      const device = devices[deviceIdx]

      // Skip devices currently in ConnectionFaulted/Communication_Faulted.
      // Their CTRL.CMD tags live on the controller but the controller is
      // routing traffic to a dead endpoint when these get written, which
      // is what saturated the CIP queue in the 2026-05-28 incident. The
      // device will be re-tried automatically on the next cycle once
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
      let deviceAborted = false
      for (const { field, value } of device.writes) {
        const tagPath = `CBT_${device.deviceName}.CTRL.CMD.${field}`
        // Skip tags already proven absent on THIS PLC — see knownMissingTags.
        const cacheKey = `${gateway}::${tagPath}`
        if (knownMissingTags.has(cacheKey)) {
          skipped++
          continue
        }
        const handle = createTag({
          gateway,
          path,
          name: tagPath,
          elemSize: 1,
          elemCount: 1,
          timeout: CREATE_TAG_TIMEOUT_MS,
        })
        if (handle >= 0) {
          handles.push({ deviceName: device.deviceName, field, tagPath, handle, value })
          consecutiveCreateFailures = 0
        } else {
          fail++
          consecutiveCreateFailures++
          // Cache ONLY definitive "not in the program" results. Transient
          // failures (timeout/busy/connection) must NOT be cached — the tag may
          // exist and should be retried once the PLC is responsive again.
          if (handle === PlcTagStatus.PLCTAG_ERR_NOT_FOUND) {
            knownMissingTags.add(cacheKey)
            // PLCTAG_ERR_NOT_FOUND is a definitive answer from the
            // controller — don't count it as a "CIP queue is sick" signal.
            consecutiveCreateFailures = 0
          }
          if (fail <= 3) {
            console.warn(`[VfdValidationWriter] createTag failed: ${tagPath}: ${getStatusMessage(handle)}`)
          }
          // Mass-failure circuit breaker. When we hit N transient
          // failures in a row across any devices, the CIP queue is
          // almost certainly saturated (or the controller is briefly
          // unreachable). Stop hammering it — Phase 2/3 will drain
          // anything we already created, and the next 10 s cycle will
          // retry with a hopefully recovered queue.
          if (consecutiveCreateFailures >= MAX_CONSECUTIVE_CREATE_FAILURES) {
            abortedAt = deviceIdx
            deviceAborted = true
            break
          }
        }
      }
      if (deviceAborted) break
    }

    if (handles.length === 0) return { ok: 0, fail, skipped, skippedFaulted, abortedAt }

    // ── Phase 2: tight read → set → write loop ────────────────────
    for (const h of handles) {
      try {
        const readSt = plc_tag_read(h.handle, 2000)
        if (readSt !== PlcTagStatus.PLCTAG_STATUS_OK) {
          fail++
          continue
        }

        plc_tag_set_int8(h.handle, 0, h.value)

        const writeSt = plc_tag_write(h.handle, 2000)
        if (writeSt === PlcTagStatus.PLCTAG_STATUS_OK) {
          ok++
        } else {
          fail++
        }
      } catch {
        fail++
      }
    }

    return { ok, fail, skipped, skippedFaulted, abortedAt }
  } finally {
    // ── Phase 3: destroy all handles ───────────────────────────────
    for (const h of handles) {
      try { plc_tag_destroy(h.handle) } catch { /* ignore */ }
    }
  }
}

// ── Main sync function ─────────────────────────────────────────────

/**
 * Read L2 data and write CMD validation flags for every validated VFD.
 *
 * Requires the PLC client to be connected.  `getPlcStatus` and `getPlcClient`
 * are imported lazily to avoid circular-dependency issues with
 * plc-client-manager (which imports us).
 */
export async function syncValidationFlags(): Promise<void> {
  // Throttle: don't run more than once every MIN_SYNC_INTERVAL_MS
  const now = Date.now()
  if (now - lastSyncMs < MIN_SYNC_INTERVAL_MS) {
    pendingSync = true
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

    const client = getPlcClient()
    if (!client.isConnected) {
      console.log('[VfdValidationWriter] Skipped: PLC not connected')
      return
    }

    const { connectionConfig } = getPlcStatus()
    if (!connectionConfig) {
      console.log('[VfdValidationWriter] Skipped: no connection config')
      return
    }

    const devices = getValidatedDevices()
    if (devices.length === 0) {
      console.log('[VfdValidationWriter] Skipped: no VFDs with commissioning progress found in L2')
      return
    }

    // Build the set of currently-faulted device names from the cached
    // tag state. This is the guard that prevents the writer from flooding
    // the CIP queue with doomed handle creations during a ring break or
    // controller hiccup. `:I.ConnectionFaulted` tags are loaded by the
    // network-status endpoint and refreshed continuously by the IO
    // reader's main poll loop (~75 ms), so the lookup is O(1) per device
    // and the data is at most a fraction of a second stale.
    const faultedDevices = buildFaultedDeviceSet(
      (name) => client.readTagCached(name),
      devices,
    )

    const t0 = Date.now()
    const { ok, fail, skipped, skippedFaulted, abortedAt } = batchWriteFlags(
      connectionConfig.ip,
      connectionConfig.path,
      devices,
      faultedDevices,
    )
    const elapsed = Date.now() - t0

    // Single structured log line per cycle. Critical for diagnosing what
    // the writer is doing in the field — operators / cloud heartbeat can
    // grep for `[VfdValidationWriter] Sync done` and see at a glance
    // whether the system is healthy (all ok), partially degraded (some
    // skipped-faulted), or short-circuited (aborted-mass-failure).
    const abortNote = abortedAt != null
      ? `, ABORTED at device ${abortedAt + 1}/${devices.length} after ${MAX_CONSECUTIVE_CREATE_FAILURES} consecutive createTag failures (CIP queue likely saturated; will retry next cycle)`
      : ''
    // Direction-checked drives with no parseable Polarity stamp: their
    // Normal/Reverse_Polarity bits CANNOT be restored after a program
    // download — the recorded fact doesn't exist. Surface them loudly so
    // field logs / cloud heartbeat show exactly which belts are exposed.
    // Only direction-checked drives are flagged — identity/HP-only drives
    // legitimately have no polarity yet and are not "exposed".
    const noPolarity = devices
      .filter(d => d.hasDirection && parsePolarity(d.polarityRaw) === null)
      .map(d => d.deviceName)
      .sort()
    // Per-flag device counts — with per-flag assertion a device may earn only
    // some flags, so this shows how far the fleet has progressed at a glance.
    const mapN = devices.filter(d => d.writes.some(w => w.field === 'Valid_Map')).length
    const hpN = devices.filter(d => d.writes.some(w => w.field === 'Valid_HP')).length
    const dirN = devices.filter(d => d.writes.some(w => w.field === 'Valid_Direction')).length
    console.log(
      `[VfdValidationWriter] Sync done: ${devices.length} device(s) ` +
      `(${mapN} map, ${hpN} hp, ${dirN} dir), ` +
      `${ok} ok, ${fail} failed, ${skipped} skipped (known-missing), ` +
      `${skippedFaulted} skipped-faulted, ${noPolarity.length} without-polarity-stamp, ` +
      `${elapsed} ms${abortNote}`,
    )
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
  }
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
    syncValidationFlags().catch(err => {
      console.error('[VfdValidationWriter] Triggered sync error:', err)
    })
  }, 2_000) // 2 s debounce — enough for the wizard to finish its burst of L2 writes
}

// ── Periodic safety-net ────────────────────────────────────────────

setInterval(() => {
  syncValidationFlags().catch(err => {
    console.error('[VfdValidationWriter] Periodic sync error:', err)
  })

  // Also flush any deferred syncs that were throttled
  if (pendingSync) {
    pendingSync = false
    syncValidationFlags().catch(err => {
      console.error('[VfdValidationWriter] Deferred sync error:', err)
    })
  }
}, 10_000).unref?.()
