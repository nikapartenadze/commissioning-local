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
  sections?: { network: boolean; estop: boolean; safety: boolean; l2: boolean }
}

export interface ApplyDeltaResult {
  resync: boolean
  applied: number
  deleted: number
  skippedDeletes: number[]
  sections: { network: boolean; estop: boolean; safety: boolean; l2: boolean }
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
        Version = @Version, Trade = @Trade, ClarificationNote = @ClarificationNote,
        NetworkDeviceName = @NetworkDeviceName,
        PunchlistStatus = CASE WHEN @PunchlistStatus IS NOT NULL THEN @PunchlistStatus ELSE Ios.PunchlistStatus END,
        CloudSyncedAt = @CloudSyncedAt,
        "Order" = @Order
    `)
  }
  return _upsertStmt
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

  if (payload.resync) {
    return { resync: true, applied: 0, deleted: 0, skippedDeletes: [], sections, toSeq: getSyncCursor(subsystemId) }
  }

  const upserts = payload.ios?.upserts ?? []
  const deletes = payload.ios?.deletes ?? []
  const skippedDeletes: number[] = []
  let applied = 0
  let deleted = 0

  const pendingStmt = db.prepare('SELECT COUNT(*) as c FROM PendingSyncs WHERE IoId = ?')
  const deleteStmt = db.prepare('DELETE FROM Ios WHERE id = ?')
  const upsert = upsertStmt()

  // One transaction: either the whole delta lands or none of it (so the cursor,
  // advanced only after, can't skip a partially-applied window).
  db.transaction(() => {
    for (const io of upserts) {
      if (!io || !io.name || io.id <= 0) continue
      upsert.run(ioToParams(io, subsystemId))
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

  return { resync: false, applied, deleted, skippedDeletes, sections, toSeq: payload.toSeq ?? getSyncCursor(subsystemId) }
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
