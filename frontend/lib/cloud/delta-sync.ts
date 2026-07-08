/**
 * Granular cloud→field delta apply.
 *
 * Replaces the destructive full pull (DELETE FROM Ios + re-upsert) for routine
 * cloud-side changes. Given a delta payload from
 * GET /api/sync/subsystem/:id/changes?since=cursor, it:
 *   - upserts changed/new IOs preserving LOCAL result authority (same ON CONFLICT
 *     as the full pull — cloud owns definitions, the field owns results/comments)
 *   - deletes removed IOs, but GUARDS rows that still hold un-pushed local work
 *     (a PendingSyncs row) so a field result is never silently dropped
 *   - reports which config sections changed (caller re-pulls those — they're
 *     non-result-authoritative)
 *   - advances the per-subsystem cursor to toSeq, but only on full success
 *
 * `resync` payloads (fresh cursor / pruning gap) bubble up so the caller falls
 * back to the full pull for a clean bootstrap.
 */

import { db, extractDeviceName } from '@/lib/db-sqlite'
import { getSyncCursor, setSyncCursor } from '@/lib/cloud/sync-cursor'
import { parseDbTimestamp } from '@/lib/cloud/pull-guard'
import { auditLog } from '@/lib/logging/recovery-log'

// Mass-delete circuit breaker (2026-07-08 durability audit): a delta payload
// carrying more than this many IO deletes is treated as a cloud-side anomaly
// (bad import / wrong-project wipe / API bug), not routine CRUD. ALL deletes in
// the payload are skipped — upserts still apply and the cursor still advances
// so the queue can't wedge; the rows simply stay until an operator runs an
// explicit full pull.
const MASS_DELETE_LIMIT = 50

const WS_BROADCAST_URL = process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast'

export interface DeltaIo {
  id: number
  name: string
  description?: string | null
  result?: string | null
  comments?: string | null
  timestamp?: string | null
  testedBy?: string | null
  order?: number | null
  installationStatus?: string | null
  installationPercent?: number | null
  poweredUp?: boolean | null
  tagType?: string | null
  version?: number | string | null
  trade?: string | null
  clarificationNote?: string | null
  networkDeviceName?: string | null
  punchlistStatus?: string | null
}

export interface DeltaPayload {
  resync?: boolean
  fromSeq?: number
  toSeq?: number
  ios?: { upserts?: DeltaIo[]; deletes?: number[] }
  sections?: {
    network: boolean; estop: boolean; safety: boolean; l2: boolean
    // Added 2026-06: the cloud now flags these too. Optional so an older cloud
    // (4-key payload) still type-checks; absent reads as falsy → no re-pull.
    punchlist?: boolean; vfdBlocker?: boolean; changeRequest?: boolean
    roadmap?: boolean; guidedTask?: boolean
  }
}

export interface ApplyDeltaResult {
  resync: boolean
  applied: number
  deleted: number
  skippedDeletes: number[]
  /** Set when the mass-delete circuit breaker fired: number of deletes blocked. */
  massDeleteBlocked?: number
  sections: {
    network: boolean; estop: boolean; safety: boolean; l2: boolean
    punchlist?: boolean; vfdBlocker?: boolean; changeRequest?: boolean
    roadmap?: boolean; guidedTask?: boolean
  }
  toSeq: number
}

// Same upsert as the full-pull route: cloud definitions win, local
// Result/Comments/Timestamp/TestedBy are preserved when already present.
let _upsertStmt: ReturnType<typeof db.prepare> | null = null
function upsertStmt() {
  if (!_upsertStmt) {
    _upsertStmt = db.prepare(`
      INSERT INTO Ios (id, Name, Description, SubsystemId, Result, Comments, Timestamp, TestedBy, IoNumber, InstallationStatus, InstallationPercent, PoweredUp, TagType, Version, Trade, ClarificationNote, NetworkDeviceName, PunchlistStatus, CloudSyncedAt, "Order")
      VALUES (@id, @Name, @Description, @SubsystemId, @Result, @Comments, @Timestamp, @TestedBy, @IoNumber, @InstallationStatus, @InstallationPercent, @PoweredUp, @TagType, @Version, @Trade, @ClarificationNote, @NetworkDeviceName, @PunchlistStatus, @CloudSyncedAt, @Order)
      ON CONFLICT(id) DO UPDATE SET
        Name = @Name, Description = @Description, SubsystemId = @SubsystemId,
        Result = CASE WHEN Ios.Result IS NOT NULL AND Ios.Result != '' THEN Ios.Result ELSE @Result END,
        Comments = CASE WHEN Ios.Comments IS NOT NULL AND Ios.Comments != '' THEN Ios.Comments ELSE @Comments END,
        Timestamp = CASE WHEN Ios.Timestamp IS NOT NULL THEN Ios.Timestamp ELSE @Timestamp END,
        TestedBy = CASE WHEN Ios.TestedBy IS NOT NULL AND Ios.TestedBy != '' THEN Ios.TestedBy ELSE @TestedBy END,
        IoNumber = @IoNumber, InstallationStatus = @InstallationStatus,
        InstallationPercent = @InstallationPercent, PoweredUp = @PoweredUp,
        TagType = CASE WHEN @TagType IS NOT NULL THEN @TagType ELSE Ios.TagType END,
        Version = @Version,
        NetworkDeviceName = @NetworkDeviceName,
        -- Resolver fields are CLOUD-owned. Apply the cloud value INCLUDING null
        -- (a genuine un-address / clear), UNLESS this tablet has an un-pushed
        -- local punchlist edit queued — then keep local so the pull can't
        -- clobber it before it syncs up. Mirrors the delete / protected-clear
        -- pending guards. (Before: PunchlistStatus coalesced null→keep-local
        -- unconditionally, so a cloud clear NEVER propagated on pull; Trade and
        -- ClarificationNote took the cloud value blindly, wiping a pending local
        -- edit. Both are now unified under the same pending guard.)
        Trade = CASE WHEN EXISTS (SELECT 1 FROM PendingSyncs WHERE IoId = Ios.id AND TestResult = 'Punchlist Updated') THEN Ios.Trade ELSE @Trade END,
        ClarificationNote = CASE WHEN EXISTS (SELECT 1 FROM PendingSyncs WHERE IoId = Ios.id AND TestResult = 'Punchlist Updated') THEN Ios.ClarificationNote ELSE @ClarificationNote END,
        PunchlistStatus = CASE WHEN EXISTS (SELECT 1 FROM PendingSyncs WHERE IoId = Ios.id AND TestResult = 'Punchlist Updated') THEN Ios.PunchlistStatus ELSE @PunchlistStatus END,
        CloudSyncedAt = @CloudSyncedAt,
        "Order" = @Order
    `)
  }
  return _upsertStmt
}

// Variant used only when the local row is a DELIBERATE, recent operator CLEAR
// that the incoming cloud value would silently revert (2026-07-08 MCM04 "keeps
// getting reset"). Keeps the local Result/Comments/Timestamp/TestedBy exactly as
// they are (i.e. cleared) while still applying the cloud DEFINITION fields, so
// the clear is honored but metadata/config stays fresh. See applyDelta's loop.
let _upsertKeepClearStmt: ReturnType<typeof db.prepare> | null = null
function upsertKeepClearStmt() {
  if (!_upsertKeepClearStmt) {
    _upsertKeepClearStmt = db.prepare(`
      INSERT INTO Ios (id, Name, Description, SubsystemId, Result, Comments, Timestamp, TestedBy, IoNumber, InstallationStatus, InstallationPercent, PoweredUp, TagType, Version, Trade, ClarificationNote, NetworkDeviceName, PunchlistStatus, CloudSyncedAt, "Order")
      VALUES (@id, @Name, @Description, @SubsystemId, @Result, @Comments, @Timestamp, @TestedBy, @IoNumber, @InstallationStatus, @InstallationPercent, @PoweredUp, @TagType, @Version, @Trade, @ClarificationNote, @NetworkDeviceName, @PunchlistStatus, @CloudSyncedAt, @Order)
      ON CONFLICT(id) DO UPDATE SET
        Name = @Name, Description = @Description, SubsystemId = @SubsystemId,
        Result = Ios.Result, Comments = Ios.Comments,
        Timestamp = Ios.Timestamp, TestedBy = Ios.TestedBy,
        IoNumber = @IoNumber, InstallationStatus = @InstallationStatus,
        InstallationPercent = @InstallationPercent, PoweredUp = @PoweredUp,
        TagType = CASE WHEN @TagType IS NOT NULL THEN @TagType ELSE Ios.TagType END,
        Version = @Version,
        NetworkDeviceName = @NetworkDeviceName,
        -- Resolver fields are CLOUD-owned. Apply the cloud value INCLUDING null
        -- (a genuine un-address / clear), UNLESS this tablet has an un-pushed
        -- local punchlist edit queued — then keep local so the pull can't
        -- clobber it before it syncs up. Mirrors the delete / protected-clear
        -- pending guards. (Before: PunchlistStatus coalesced null→keep-local
        -- unconditionally, so a cloud clear NEVER propagated on pull; Trade and
        -- ClarificationNote took the cloud value blindly, wiping a pending local
        -- edit. Both are now unified under the same pending guard.)
        Trade = CASE WHEN EXISTS (SELECT 1 FROM PendingSyncs WHERE IoId = Ios.id AND TestResult = 'Punchlist Updated') THEN Ios.Trade ELSE @Trade END,
        ClarificationNote = CASE WHEN EXISTS (SELECT 1 FROM PendingSyncs WHERE IoId = Ios.id AND TestResult = 'Punchlist Updated') THEN Ios.ClarificationNote ELSE @ClarificationNote END,
        PunchlistStatus = CASE WHEN EXISTS (SELECT 1 FROM PendingSyncs WHERE IoId = Ios.id AND TestResult = 'Punchlist Updated') THEN Ios.PunchlistStatus ELSE @PunchlistStatus END,
        CloudSyncedAt = @CloudSyncedAt,
        "Order" = @Order
    `)
  }
  return _upsertKeepClearStmt
}

// A local row is a "protected clear" when it has NO result now but its latest
// TestHistories entry is an operator 'Cleared' that the cloud value has NOT
// provably superseded (cloud carries no newer timestamp). Restoring the cloud
// result over such a clear is the reset loop; this returns true to keep it.
let _clearGuardStmt: ReturnType<typeof db.prepare> | null = null
function isProtectedClear(io: DeltaIo): boolean {
  const cloudHasResult = io.result != null && String(io.result).trim() !== ''
  if (!cloudHasResult) return false // pull wouldn't restore anything
  const local = db.prepare('SELECT Result FROM Ios WHERE id = ?').get(io.id) as { Result: string | null } | undefined
  if (!local) return false // brand-new IO — nothing local to protect
  if (local.Result != null && String(local.Result).trim() !== '') return false // has a result → other guards own it
  if (!_clearGuardStmt) {
    _clearGuardStmt = db.prepare(
      'SELECT Result AS r, Timestamp AS ts FROM TestHistories WHERE IoId = ? ORDER BY id DESC LIMIT 1'
    )
  }
  const last = _clearGuardStmt.get(io.id) as { r: string | null; ts: string | null } | undefined
  if (!last || last.r !== 'Cleared') return false // not a deliberate clear (never tested / stale-null)
  const clearedAt = parseDbTimestamp(last.ts)
  if (!Number.isFinite(clearedAt)) return true // deliberate clear, no ts to compare → protect (safe default)
  const cloudTs = Date.parse(io.timestamp ?? '')
  // Cloud provably newer than the clear → a real later edit wins; don't protect.
  if (Number.isFinite(cloudTs) && cloudTs > clearedAt) return false
  return true
}

function ioToParams(io: DeltaIo, subsystemId: number) {
  return {
    id: io.id,
    Name: io.name,
    Description: io.description ?? null,
    SubsystemId: subsystemId,
    Result: io.result ?? null,
    Comments: io.comments ?? null,
    Timestamp: io.timestamp ?? null,
    TestedBy: io.testedBy ?? null,
    IoNumber: io.order ?? null,
    InstallationStatus: io.installationStatus ?? null,
    InstallationPercent: io.installationPercent ?? null,
    PoweredUp: io.poweredUp === true ? 1 : io.poweredUp === false ? 0 : null,
    TagType: io.tagType ?? null,
    Version: Number(io.version) || 0,
    Trade: io.trade ?? null,
    ClarificationNote: io.clarificationNote ?? null,
    NetworkDeviceName: io.networkDeviceName ?? extractDeviceName(io.name) ?? null,
    PunchlistStatus: io.punchlistStatus ?? null,
    CloudSyncedAt: new Date().toISOString(),
    Order: io.order ?? null,
  }
}

/**
 * Apply a delta payload to the local DB and advance the cursor. Pure DB work —
 * no network — so it's unit-testable against an in-memory database.
 */
export function applyDelta(subsystemId: number, payload: DeltaPayload): ApplyDeltaResult {
  const sections = payload.sections ?? { network: false, estop: false, safety: false, l2: false }

  const upserts = payload.ios?.upserts ?? []

  // A resync WITHOUT a snapshot (legacy / pruning-gap with no payload) tells the
  // caller to fall back to a full pull. A resync WITH a snapshot carries the
  // full IO set — apply it through the SAME non-gated granular path below (and
  // advance the cursor to toSeq), so cold-start bootstraps even while the
  // offline queue is non-empty (no queue-gated full pull, no propagation gap).
  if (payload.resync && upserts.length === 0) {
    return {
      resync: true,
      applied: 0,
      deleted: 0,
      skippedDeletes: [],
      sections,
      toSeq: typeof payload.toSeq === 'number' ? payload.toSeq : getSyncCursor(subsystemId),
    }
  }

  let deletes = payload.ios?.deletes ?? []

  // Circuit breaker: refuse to apply a suspiciously-large bulk delete. Per-row
  // guarded deletes below stay as-is for payloads at or under the limit.
  let massDeleteBlocked = 0
  if (deletes.length > MASS_DELETE_LIMIT) {
    massDeleteBlocked = deletes.length
    console.warn(
      `[Delta] Subsystem ${subsystemId}: MASS-DELETE BLOCKED — payload asked to delete ` +
      `${massDeleteBlocked} IOs (> ${MASS_DELETE_LIMIT}). Skipping ALL deletes; upserts still ` +
      `apply and the cursor advances. Rows stay local until an operator runs an explicit full pull.`
    )
    auditLog({ type: 'sync.pull', detail: { route: 'delta', massDeleteBlocked, subsystemId } })
    deletes = []
  }

  const skippedDeletes: number[] = []
  let applied = 0
  let deleted = 0

  const pendingStmt = db.prepare('SELECT COUNT(*) as c FROM PendingSyncs WHERE IoId = ?')
  const deleteStmt = db.prepare('DELETE FROM Ios WHERE id = ?')
  const upsert = upsertStmt()
  const upsertKeepClear = upsertKeepClearStmt()
  let protectedClears = 0

  // One transaction: either the whole delta lands or none of it (so the cursor,
  // advanced only after, can't skip a partially-applied window).
  db.transaction(() => {
    for (const io of upserts) {
      if (!io || !io.name || io.id <= 0) continue
      // A deliberate, recent operator clear must not be silently reverted by the
      // cloud's stale higher-versioned result (the MCM04 reset loop). Keep the
      // clear; still apply the cloud definition fields.
      if (isProtectedClear(io)) {
        upsertKeepClear.run(ioToParams(io, subsystemId))
        protectedClears++
      } else {
        upsert.run(ioToParams(io, subsystemId))
      }
      applied++
    }
    for (const id of deletes) {
      const pending = (pendingStmt.get(id) as { c: number }).c
      if (pending > 0) {
        // Field tested this IO and the result hasn't synced yet — keep the row
        // (and its pending result) rather than dropping local work to honor a
        // cloud delete. Surfaced for attention.
        skippedDeletes.push(id)
        continue
      }
      deleteStmt.run(id)
      deleted++
    }
  })()

  // Forward-only; advanced only after a clean apply.
  if (typeof payload.toSeq === 'number' && payload.toSeq > 0) {
    setSyncCursor(subsystemId, payload.toSeq)
  }

  if (skippedDeletes.length > 0) {
    console.warn(`[Delta] Subsystem ${subsystemId}: kept ${skippedDeletes.length} cloud-deleted IO(s) with un-pushed local results: ${skippedDeletes.join(', ')}`)
  }
  if (protectedClears > 0) {
    console.warn(`[Delta] Subsystem ${subsystemId}: preserved ${protectedClears} deliberate local clear(s) the cloud would have reverted (stale higher-versioned result held back).`)
  }

  return {
    resync: false,
    applied,
    deleted,
    skippedDeletes,
    ...(massDeleteBlocked > 0 ? { massDeleteBlocked } : {}),
    sections,
    toSeq: payload.toSeq ?? getSyncCursor(subsystemId),
  }
}

/**
 * Fetch the delta for a subsystem and apply it. Returns the apply result;
 * `resync: true` tells the caller to fall back to the full pull. Broadcasts
 * upserted IOs to browser tabs so the grid updates live.
 */
export async function fetchAndApplyDelta(
  subsystemId: number,
  config: { remoteUrl: string; apiPassword?: string },
): Promise<ApplyDeltaResult> {
  const since = getSyncCursor(subsystemId)
  const url = `${config.remoteUrl}/api/sync/subsystem/${subsystemId}/changes?since=${since}`
  const res = await fetch(url, {
    headers: { 'X-API-Key': config.apiPassword || '' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`delta HTTP ${res.status}`)
  }
  const payload = (await res.json()) as DeltaPayload
  const result = applyDelta(subsystemId, payload)

  // Nudge browser tabs to refresh the IOs we changed (deletes are reflected on
  // next reload). Best-effort.
  for (const io of payload.ios?.upserts ?? []) {
    fetch(WS_BROADCAST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'UpdateIO',
        id: io.id,
        result: io.result || 'Not Tested',
        state: '',
        timestamp: io.timestamp ?? '',
        comments: io.comments ?? '',
      }),
    }).catch(() => { /* WS broadcast best-effort */ })
  }

  return result
}
