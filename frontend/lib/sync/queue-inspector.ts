import { db } from '@/lib/db-sqlite'

/**
 * Sync Center — read/triage layer over the three OUTBOUND sync queue tables.
 *
 * DATA-SAFETY CONTRACT (this is the field tool):
 *  - This module ONLY ever reads/updates/deletes rows in the three *PendingSyncs
 *    QUEUE tables (PendingSyncs, L2PendingSyncs, DeviceBlockerPendingSyncs).
 *  - It NEVER touches Ios, L2CellValues, L2Devices, L2Columns, TestHistories, or
 *    any other data table (the LEFT JOINs below are read-only lookups for display
 *    labels; they never write). The real values live in those data tables — a
 *    queue row is just an OUTBOUND COPY waiting to be pushed to the cloud.
 *  - discard() removes ONLY the queue row (stops re-sending); the underlying
 *    value in the data table is untouched.
 *  - `kind` is resolved through a fixed whitelist map, never string-interpolated
 *    into SQL, so it can never be used to build an arbitrary table name.
 */

export type QueueKind = 'io' | 'l2' | 'blocker'
export type Classification = 'gone_on_cloud' | 'version_conflict' | 'transient' | 'unknown'

export interface QueueItem {
  kind: QueueKind
  id: number
  // Owning MCM/subsystem so the Sync Center can attribute + filter + scope bulk
  // actions per MCM. NULL only for legacy single-MCM rows (e.g. an L2 device
  // that predates per-MCM scoping) — those show as "Unassigned".
  subsystemId: number | null
  mcm: string | null
  title: string
  subtitle: string | null
  value: string | null
  // Three outbound-sync states (Orphaned layered on DeadLettered):
  //   pending  = DeadLettered=0                (auto-sync keeps retrying)
  //   parked   = DeadLettered=1 AND Orphaned=0 (stopped — needs a human)
  //   orphaned = Orphaned=1                    (cloud target removed; auto-restores)
  status: 'pending' | 'parked' | 'orphaned'
  classification: Classification
  reason: string
  lastError: string | null
  retryCount: number
  createdAt: string | null
  ageMinutes: number | null
}

// Whitelist: `kind` NEVER reaches SQL as text — it only ever indexes this map.
const TABLE_BY_KIND: Record<QueueKind, string> = {
  io: 'PendingSyncs',
  l2: 'L2PendingSyncs',
  blocker: 'DeviceBlockerPendingSyncs',
}

const REASONS: Record<Classification, string> = {
  gone_on_cloud:
    'This device/IO no longer exists on the cloud (it was removed). Nothing to sync to — safe to discard.',
  version_conflict:
    'A newer value already exists on the cloud for this item. Retrying will re-base on the cloud value.',
  transient:
    'Temporary network/cloud problem. Should clear on its own; Retry to force it now.',
  unknown: 'Unknown sync error.',
}

/**
 * Map a raw LastError string to a plain-English classification + reason.
 * Order matters: 'gone' and 'conflict' are checked before the broad transient
 * network bucket so a 404/409 is never mislabelled as a network blip.
 */
export function classify(lastError: string | null): { classification: Classification; reason: string } {
  const e = (lastError || '').toLowerCase()
  if (!e) return { classification: 'unknown', reason: REASONS.unknown }

  // Only a true HTTP removal (403/404/410) is "gone — safe to discard".
  // NOTE: updatedCount=0 is intentionally NOT here — it's an ambiguous
  // version-mismatch ghost the B7 reconcile heals, so it must read as a
  // version conflict (retry/auto-heals), never "safe to discard".
  if (/\b40[34]\b|410|not found|no longer exists|does not exist/.test(e)) {
    return { classification: 'gone_on_cloud', reason: REASONS.gone_on_cloud }
  }
  if (/version|rebased|409|conflict|updatedcount=0/.test(e)) {
    return { classification: 'version_conflict', reason: REASONS.version_conflict }
  }
  if (/timeout|econn|network|fetch failed|5\d\d|socket/.test(e)) {
    return { classification: 'transient', reason: REASONS.transient }
  }
  // Unknown: surface the raw error so the tech sees exactly what the cloud said.
  return { classification: 'unknown', reason: lastError || REASONS.unknown }
}

/**
 * Age in whole minutes from a CreatedAt timestamp. Guards nulls and both
 * accepted shapes: ISO ('2026-07-14T10:00:00Z') and SQLite datetime('now')
 * ('2026-07-14 10:00:00', which is UTC). Returns null if unparseable.
 */
function ageMinutesOf(createdAt: string | null | undefined): number | null {
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

function statusOf(deadLettered: unknown, orphaned: unknown): 'pending' | 'parked' | 'orphaned' {
  // Orphaned wins (it's a subset of DeadLettered — the invariant guarantees
  // DeadLettered=1 here too), then parked, then pending.
  if (Number(orphaned) === 1) return 'orphaned'
  return Number(deadLettered) === 1 ? 'parked' : 'pending'
}

function buildItem(
  kind: QueueKind,
  id: number,
  subsystemId: unknown,
  mcm: string | null,
  title: string,
  subtitle: string | null,
  value: string | null,
  deadLettered: unknown,
  lastError: string | null,
  retryCount: unknown,
  createdAt: string | null,
  orphaned: unknown,
): QueueItem {
  const { classification, reason } = classify(lastError)
  const sid = subsystemId == null ? null : Number(subsystemId)
  return {
    kind,
    id,
    subsystemId: sid != null && Number.isFinite(sid) ? sid : null,
    mcm: mcm ?? null,
    title,
    subtitle,
    value,
    status: statusOf(deadLettered, orphaned),
    classification,
    reason,
    lastError: lastError ?? null,
    retryCount: Number(retryCount) || 0,
    createdAt: createdAt ?? null,
    ageMinutes: ageMinutesOf(createdAt),
  }
}

/** IO queue rows (PendingSyncs) → titled by the joined Ios row. */
function readIoRows(): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT ps.id AS id, ps.IoId AS IoId, ps.TestResult AS TestResult,
              ps.DeadLettered AS DeadLettered, ps.Orphaned AS Orphaned, ps.LastError AS LastError,
              ps.RetryCount AS RetryCount, ps.CreatedAt AS CreatedAt,
              i.Name AS IoName, i.Description AS IoDescription,
              i.SubsystemId AS SubsystemId, s.Name AS Mcm
         FROM PendingSyncs ps
         LEFT JOIN Ios i ON ps.IoId = i.id
         LEFT JOIN Subsystems s ON s.id = i.SubsystemId
        ORDER BY ps.CreatedAt ASC, ps.id ASC`,
    )
    .all() as any[]
  return rows.map((r) => {
    const title = (r.IoName && String(r.IoName)) || `IO #${r.IoId}`
    const subtitle = r.IoDescription != null ? String(r.IoDescription) : null
    return buildItem('io', r.id, r.SubsystemId, r.Mcm ?? null, title, subtitle, r.TestResult ?? null, r.DeadLettered, r.LastError ?? null, r.RetryCount, r.CreatedAt ?? null, r.Orphaned)
  })
}

/** L2 (FV/VFD cell) queue rows → resolved via CloudId back-refs on device+column. */
function readL2Rows(): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT lp.id AS id, lp.CloudDeviceId AS CloudDeviceId, lp.CloudColumnId AS CloudColumnId,
              lp.Value AS Value, lp.DeadLettered AS DeadLettered, lp.Orphaned AS Orphaned, lp.LastError AS LastError,
              lp.RetryCount AS RetryCount, lp.CreatedAt AS CreatedAt,
              d.DeviceName AS DeviceName, d.Mcm AS Mcm, d.SubsystemId AS SubsystemId,
              COALESCE(s.Name, d.Mcm) AS McmName, c.Name AS ColumnName
         FROM L2PendingSyncs lp
         LEFT JOIN L2Devices d ON d.CloudId = lp.CloudDeviceId
         LEFT JOIN Subsystems s ON s.id = d.SubsystemId
         LEFT JOIN L2Columns c ON c.CloudId = lp.CloudColumnId
        ORDER BY lp.CreatedAt ASC, lp.id ASC`,
    )
    .all() as any[]
  return rows.map((r) => {
    const name = r.DeviceName ? String(r.DeviceName) : `Device #${r.CloudDeviceId}`
    const title = r.Mcm ? `${name} · ${r.Mcm}` : name
    const subtitle = r.ColumnName != null ? String(r.ColumnName) : `Column #${r.CloudColumnId}`
    return buildItem('l2', r.id, r.SubsystemId, r.McmName ?? null, title, subtitle, r.Value ?? null, r.DeadLettered, r.LastError ?? null, r.RetryCount, r.CreatedAt ?? null, r.Orphaned)
  })
}

/** Device-blocker queue rows (VFD bump-test blockers). */
function readBlockerRows(): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT bp.id AS id, bp.DeviceName AS DeviceName, bp.Op AS Op,
              bp.BlockerResponsibleParty AS BlockerResponsibleParty, bp.BlockerDescription AS BlockerDescription,
              bp.DeadLettered AS DeadLettered, bp.Orphaned AS Orphaned, bp.LastError AS LastError,
              bp.RetryCount AS RetryCount, bp.CreatedAt AS CreatedAt,
              bp.SubsystemId AS SubsystemId, s.Name AS Mcm
         FROM DeviceBlockerPendingSyncs bp
         LEFT JOIN Subsystems s ON s.id = bp.SubsystemId
        ORDER BY bp.CreatedAt ASC, bp.id ASC`,
    )
    .all() as any[]
  return rows.map((r) => {
    const title = r.DeviceName ? String(r.DeviceName) : `Blocker #${r.id}`
    const party = r.BlockerResponsibleParty ? String(r.BlockerResponsibleParty) : null
    const op = r.Op ? String(r.Op) : ''
    const subtitle = [op, party].filter(Boolean).join(' · ') || null
    return buildItem('blocker', r.id, r.SubsystemId, r.Mcm ?? null, title, subtitle, r.BlockerDescription ?? null, r.DeadLettered, r.LastError ?? null, r.RetryCount, r.CreatedAt ?? null, r.Orphaned)
  })
}

export function listQueue(opts?: {
  status?: 'all' | 'pending' | 'parked' | 'orphaned'
  /**
   * Restrict to ONE MCM. This is the per-MCM scoping that makes bulk actions
   * safe: an operator filtered to MCM05 sees + retries + discards ONLY MCM05's
   * rows and can never touch MCM01's. Omit for the global (all-MCM) view.
   */
  subsystemId?: number
}): {
  summary: { pending: number; parked: number; orphaned: number; byClassification: Record<Classification, number> }
  items: QueueItem[]
} {
  const wantStatus = opts?.status ?? 'all'
  const wantSubsystem =
    opts?.subsystemId != null && Number.isFinite(opts.subsystemId) ? Number(opts.subsystemId) : null

  // Each table read is isolated so a missing table/column never 500s the list.
  let items: QueueItem[] = []
  for (const read of [readIoRows, readL2Rows, readBlockerRows]) {
    try {
      items = items.concat(read())
    } catch (e) {
      console.warn(`[SyncCenter] queue read failed for ${read.name}:`, (e as Error)?.message || e)
    }
  }

  // Per-MCM scope FIRST, so both the summary counts and the returned rows
  // reflect only the selected MCM.
  if (wantSubsystem != null) {
    items = items.filter((i) => i.subsystemId === wantSubsystem)
  }

  const summary = {
    pending: 0,
    parked: 0,
    orphaned: 0,
    byClassification: { gone_on_cloud: 0, version_conflict: 0, transient: 0, unknown: 0 } as Record<Classification, number>,
  }
  for (const it of items) {
    if (it.status === 'orphaned') summary.orphaned++
    else if (it.status === 'parked') summary.parked++
    else summary.pending++
    summary.byClassification[it.classification]++
  }

  const filtered = wantStatus === 'all' ? items : items.filter((i) => i.status === wantStatus)

  // Order: parked (needs a human) first, then orphaned (removed on cloud), then
  // pending; oldest first within each group.
  const rank = (s: QueueItem['status']) => (s === 'parked' ? 0 : s === 'orphaned' ? 1 : 2)
  filtered.sort((a, b) => {
    if (a.status !== b.status) return rank(a.status) - rank(b.status)
    return (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1)
  })

  return { summary, items: filtered }
}

/**
 * Re-queue rows for the normal drain: clear the parked flag + reset the retry
 * counter/error so auto-sync picks them up again. QUEUE TABLE ONLY.
 */
export function retry(refs: { kind: QueueKind; id: number }[]): { affected: number } {
  let affected = 0
  for (const ref of refs) {
    const table = TABLE_BY_KIND[ref.kind]
    if (!table || !Number.isInteger(ref.id)) continue
    try {
      const info = db
        .prepare(`UPDATE ${table} SET DeadLettered = 0, Orphaned = 0, RetryCount = 0, LastError = NULL WHERE id = ?`)
        .run(ref.id)
      affected += info.changes
    } catch (e) {
      console.warn(`[SyncCenter] retry failed for ${ref.kind}#${ref.id}:`, (e as Error)?.message || e)
    }
  }
  return { affected }
}

/**
 * Full display details of the given refs, BEFORE they are discarded — so the
 * caller can write a human-readable record of exactly what was cleared.
 */
export function snapshotRefs(refs: { kind: QueueKind; id: number }[]): QueueItem[] {
  if (!refs?.length) return []
  const wanted = new Set(refs.map((r) => `${r.kind}:${r.id}`))
  return listQueue().items.filter((i) => wanted.has(`${i.kind}:${i.id}`))
}

/**
 * Delete ONLY the outbound queue row (stops re-sending). The underlying value
 * in Ios / L2CellValues / Devices is NOT touched — this can never delete data.
 */
export function discard(refs: { kind: QueueKind; id: number }[]): { affected: number } {
  let affected = 0
  for (const ref of refs) {
    const table = TABLE_BY_KIND[ref.kind]
    if (!table || !Number.isInteger(ref.id)) continue
    try {
      const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(ref.id)
      affected += info.changes
    } catch (e) {
      console.warn(`[SyncCenter] discard failed for ${ref.kind}#${ref.id}:`, (e as Error)?.message || e)
    }
  }
  return { affected }
}

/**
 * Resolve a bulk selector down to concrete { kind, id } refs.
 *  - `ids`: passed straight through (explicit selection).
 *  - `classification`: every PARKED row of that classification.
 *  - `allParked`: every parked row regardless of classification.
 *  - `allOrphaned`: every orphaned row (removed-on-cloud).
 * Classification/allParked/allOrphaned scan the matching status via listQueue so
 * the resolution and the displayed list can never diverge.
 */
export function selectRefs(sel: {
  ids?: { kind: QueueKind; id: number }[]
  classification?: Classification
  allParked?: boolean
  allOrphaned?: boolean
  /**
   * When set, every bulk selector (allParked/allOrphaned/classification) resolves
   * ONLY rows of that MCM — so "Discard all parked" on the MCM05-filtered view
   * can never touch MCM01's queue. Explicit `ids` are still honored as-is (the
   * caller already chose exact rows). Omit for a deliberate all-MCM bulk action.
   */
  subsystemId?: number
}): { kind: QueueKind; id: number }[] {
  if (sel.ids && sel.ids.length) {
    return sel.ids
      .filter((r) => r && (r.kind === 'io' || r.kind === 'l2' || r.kind === 'blocker') && Number.isInteger(r.id))
      .map((r) => ({ kind: r.kind, id: r.id }))
  }

  const scope = sel.subsystemId != null ? { subsystemId: sel.subsystemId } : {}

  if (sel.allOrphaned) {
    return listQueue({ status: 'orphaned', ...scope }).items.map((i) => ({ kind: i.kind, id: i.id }))
  }

  if (sel.classification || sel.allParked) {
    const parked = listQueue({ status: 'parked', ...scope }).items
    const matched = sel.classification
      ? parked.filter((i) => i.classification === sel.classification)
      : parked
    return matched.map((i) => ({ kind: i.kind, id: i.id }))
  }

  return []
}
