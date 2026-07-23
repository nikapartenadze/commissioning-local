import { db } from '@/lib/db-sqlite'
import { classify, ageMinutesOf } from './queue-display'
import type { Classification } from './queue-display'

/**
 * Sync Center — read/triage layer over ALL FIVE OUTBOUND sync queue tables.
 *
 * This is the SINGLE SOURCE OF TRUTH for stuck/pending sync state. Every durable
 * outbound queue is surfaced here so a parked row — including a SAFETY e-stop
 * check or a guided-mode override, which previously had NO operator UI at all —
 * is always visible and recoverable (retry/discard) from the Sync Center.
 *
 * DATA-SAFETY CONTRACT (this is the field tool):
 *  - This module ONLY ever reads/updates/deletes rows in the five *PendingSyncs
 *    QUEUE tables (PendingSyncs, L2PendingSyncs, DeviceBlockerPendingSyncs,
 *    EStopCheckPendingSyncs, GuidedTaskStatePendingSyncs).
 *  - It NEVER touches Ios, L2CellValues, L2Devices, L2Columns, TestHistories, or
 *    any other data table (the LEFT JOINs below are read-only lookups for display
 *    labels; they never write). The real values live in those data tables — a
 *    queue row is just an OUTBOUND COPY waiting to be pushed to the cloud.
 *  - discard() removes ONLY the queue row (stops re-sending); the underlying
 *    value in the data table is untouched.
 *  - `kind` is resolved through a fixed whitelist map, never string-interpolated
 *    into SQL, so it can never be used to build an arbitrary table name.
 */

export type QueueKind = 'io' | 'l2' | 'blocker' | 'estop' | 'guided'

export interface QueueItem {
  kind: QueueKind
  /** The QUEUE ROW's own id — NOT the id of whatever it targets. */
  id: number
  /**
   * The Ios row this queue row targets. Set ONLY for kind==='io'; the other four
   * queues key on device/column/zone/task, which are not IOs. Kept distinct from
   * `id` so a queue-row id can never be mistaken for (or reported as) an IO id.
   */
  ioId: number | null
  // Owning MCM/subsystem so the Sync Center can attribute + filter + scope bulk
  // actions per MCM. NULL only for legacy single-MCM rows (e.g. an L2 device
  // that predates per-MCM scoping) — those show as "Unassigned".
  subsystemId: number | null
  mcm: string | null
  title: string
  subtitle: string | null
  value: string | null
  // Four outbound-sync states (each layered on the previous):
  //   pending  = DeadLettered=0                             (auto-sync keeps retrying)
  //   parked   = DeadLettered=1 AND Orphaned=0              (stopped — needs a human)
  //   orphaned = Orphaned=1 AND Resolved=0                  (cloud target removed; auto-restores)
  //   resolved = Resolved=1                                 (TERMINAL — nobody owes it anything)
  // `resolved` is EXCLUDED from listQueue unless asked for by name, so it never
  // reaches the default view or the summary counts. The row itself is kept.
  status: 'pending' | 'parked' | 'orphaned' | 'resolved'
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
  estop: 'EStopCheckPendingSyncs',
  guided: 'GuidedTaskStatePendingSyncs',
}

// IO/L2/blocker carry an Orphaned flag (confirmed cloud-removal, auto-requeues on
// reappearance). The e-stop + guided tables have DeadLettered but NO Orphaned
// column — retry() must not reference Orphaned for those, and they can only be
// pending or parked (never orphaned).
const KINDS_WITH_ORPHANED: ReadonlySet<QueueKind> = new Set<QueueKind>(['io', 'l2', 'blocker'])

/**
 * Canonical DISPLAY surface — the pure (db-free) triage/verdict logic now lives
 * in ./queue-display so the /sync tablet page can import the SAME code without
 * dragging better-sqlite3 into the browser bundle. Re-exported here so every
 * existing importer of THIS module keeps resolving unchanged; queue-inspector
 * itself uses classify + ageMinutesOf (imported above) for its db-backed reads.
 */
export {
  classify,
  REASONS,
  authStatusFromError,
  formatDuration,
  displayVerdict,
  STALE_AFTER_MIN,
} from './queue-display'
export type {
  Classification,
  DisplayTone,
  DisplayVerdict,
  DisplayRow,
} from './queue-display'

function statusOf(deadLettered: unknown, orphaned: unknown, resolved: unknown): QueueItem['status'] {
  // Most specific first: Resolved ⊂ Orphaned ⊂ DeadLettered, so the invariants
  // guarantee the outer flags are set too whenever an inner one is.
  if (Number(resolved) === 1) return 'resolved'
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
  resolved: unknown,
): QueueItem {
  const { classification, reason } = classify(lastError)
  const sid = subsystemId == null ? null : Number(subsystemId)
  return {
    kind,
    id,
    // Overridden by readIoRows with the real IoId; every other queue has none.
    ioId: null,
    subsystemId: sid != null && Number.isFinite(sid) ? sid : null,
    mcm: mcm ?? null,
    title,
    subtitle,
    value,
    status: statusOf(deadLettered, orphaned, resolved),
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
              ps.DeadLettered AS DeadLettered, ps.Orphaned AS Orphaned, ps.Resolved AS Resolved, ps.LastError AS LastError,
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
    const ioId = r.IoId == null ? null : Number(r.IoId)
    return {
      ...buildItem('io', r.id, r.SubsystemId, r.Mcm ?? null, title, subtitle, r.TestResult ?? null, r.DeadLettered, r.LastError ?? null, r.RetryCount, r.CreatedAt ?? null, r.Orphaned, r.Resolved),
      ioId: ioId != null && Number.isFinite(ioId) ? ioId : null,
    }
  })
}

/** L2 (FV/VFD cell) queue rows → resolved via CloudId back-refs on device+column. */
function readL2Rows(): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT lp.id AS id, lp.CloudDeviceId AS CloudDeviceId, lp.CloudColumnId AS CloudColumnId,
              lp.Value AS Value, lp.DeadLettered AS DeadLettered, lp.Orphaned AS Orphaned, lp.Resolved AS Resolved, lp.LastError AS LastError,
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
    return buildItem('l2', r.id, r.SubsystemId, r.McmName ?? null, title, subtitle, r.Value ?? null, r.DeadLettered, r.LastError ?? null, r.RetryCount, r.CreatedAt ?? null, r.Orphaned, r.Resolved)
  })
}

/** Device-blocker queue rows (VFD bump-test blockers). */
function readBlockerRows(): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT bp.id AS id, bp.DeviceName AS DeviceName, bp.Op AS Op,
              bp.BlockerResponsibleParty AS BlockerResponsibleParty, bp.BlockerDescription AS BlockerDescription,
              bp.DeadLettered AS DeadLettered, bp.Orphaned AS Orphaned, bp.Resolved AS Resolved, bp.LastError AS LastError,
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
    return buildItem('blocker', r.id, r.SubsystemId, r.Mcm ?? null, title, subtitle, r.BlockerDescription ?? null, r.DeadLettered, r.LastError ?? null, r.RetryCount, r.CreatedAt ?? null, r.Orphaned, r.Resolved)
  })
}

/** E-stop safety-check queue rows (EStopCheckPendingSyncs — no Orphaned column). */
function readEstopRows(): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT ep.id AS id, ep.SubsystemId AS SubsystemId, ep.ZoneName AS ZoneName, ep.CheckTag AS CheckTag,
              ep.Result AS Result, ep.CheckType AS CheckType, ep.DeadLettered AS DeadLettered,
              ep.LastError AS LastError, ep.RetryCount AS RetryCount, ep.CreatedAt AS CreatedAt,
              s.Name AS Mcm
         FROM EStopCheckPendingSyncs ep
         LEFT JOIN Subsystems s ON s.id = ep.SubsystemId
        ORDER BY ep.CreatedAt ASC, ep.id ASC`,
    )
    .all() as any[]
  return rows.map((r) => {
    const title = r.ZoneName ? String(r.ZoneName) : (r.CheckTag ? String(r.CheckTag) : `E-stop check #${r.id}`)
    const subtitle = [r.CheckType ? String(r.CheckType) : null, r.CheckTag ? String(r.CheckTag) : null].filter(Boolean).join(' · ') || null
    // No Orphaned column → pass 0 for both (never orphaned, never resolved;
    // only pending/parked). Resolved ⊂ Orphaned, so 0 is the correct constant.
    return buildItem('estop', r.id, r.SubsystemId, r.Mcm ?? null, title, subtitle, r.Result ?? null, r.DeadLettered, r.LastError ?? null, r.RetryCount, r.CreatedAt ?? null, 0, 0)
  })
}

/** Guided-mode task-state override queue rows (GuidedTaskStatePendingSyncs — no Orphaned column). */
function readGuidedRows(): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT gp.id AS id, gp.SubsystemId AS SubsystemId, gp.TaskId AS TaskId, gp.Status AS Status,
              gp.Reason AS Reason, gp.DeadLettered AS DeadLettered, gp.LastError AS LastError,
              gp.RetryCount AS RetryCount, gp.CreatedAt AS CreatedAt, s.Name AS Mcm
         FROM GuidedTaskStatePendingSyncs gp
         LEFT JOIN Subsystems s ON s.id = gp.SubsystemId
        ORDER BY gp.CreatedAt ASC, gp.id ASC`,
    )
    .all() as any[]
  return rows.map((r) => {
    const title = r.TaskId ? String(r.TaskId) : `Guided task #${r.id}`
    const subtitle = r.Status ? String(r.Status) : null
    return buildItem('guided', r.id, r.SubsystemId, r.Mcm ?? null, title, subtitle, r.Reason ?? r.Status ?? null, r.DeadLettered, r.LastError ?? null, r.RetryCount, r.CreatedAt ?? null, 0, 0)
  })
}

export function listQueue(opts?: {
  /**
   * 'all' means all NON-RESOLVED rows. Resolved rows are terminal (their cloud
   * target is provably gone) and are only returned when asked for BY NAME, so
   * they can never leak into the default view, the summary, or a bulk selector.
   * They remain fully queryable here for forensics — never deleted.
   */
  status?: 'all' | 'pending' | 'parked' | 'orphaned' | 'resolved'
  /**
   * Restrict to ONE MCM. This is the per-MCM scoping that makes bulk actions
   * safe: an operator filtered to MCM05 sees + retries + discards ONLY MCM05's
   * rows and can never touch MCM01's. Omit for the global (all-MCM) view.
   */
  subsystemId?: number
}): {
  summary: { pending: number; parked: number; orphaned: number; resolved: number; byClassification: Record<Classification, number> }
  items: QueueItem[]
} {
  const wantStatus = opts?.status ?? 'all'
  const wantSubsystem =
    opts?.subsystemId != null && Number.isFinite(opts.subsystemId) ? Number(opts.subsystemId) : null

  // Each table read is isolated so a missing table/column never 500s the list.
  let items: QueueItem[] = []
  for (const read of [readIoRows, readL2Rows, readBlockerRows, readEstopRows, readGuidedRows]) {
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
    resolved: 0,
    byClassification: { gone_on_cloud: 0, version_conflict: 0, transient: 0, cloud_rejected: 0, unknown: 0, auth_error: 0 } as Record<Classification, number>,
  }
  for (const it of items) {
    if (it.status === 'resolved') { summary.resolved++; continue }  // terminal — counted, never classified into the to-do buckets
    if (it.status === 'orphaned') summary.orphaned++
    else if (it.status === 'parked') summary.parked++
    else summary.pending++
    summary.byClassification[it.classification]++
  }

  // Resolved rows are terminal: excluded from 'all' (the default view + every
  // bulk selector that runs through it), returned only on an explicit ask.
  const filtered = wantStatus === 'all'
    ? items.filter((i) => i.status !== 'resolved')
    : items.filter((i) => i.status === wantStatus)

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
      // e-stop + guided have no Orphaned column — don't reference it there.
      // Resolved exists on all five (added for parity) and MUST be cleared here:
      // un-parking a row while it stays Resolved would leave it invisible to
      // every active-queue read, i.e. a retry that silently does nothing.
      const orphanClause = KINDS_WITH_ORPHANED.has(ref.kind) ? ', Orphaned = 0' : ''
      const info = db
        .prepare(`UPDATE ${table} SET DeadLettered = 0${orphanClause}, Resolved = 0, ResolvedAt = NULL, ResolvedReason = NULL, RetryCount = 0, LastError = NULL WHERE id = ?`)
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
      .filter((r) => r && (r.kind as QueueKind) in TABLE_BY_KIND && Number.isInteger(r.id))
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
