import { db } from '@/lib/db-sqlite'
import { listQueue, REASONS, type Classification, type QueueKind } from '@/lib/sync/queue-inspector'
import { attributeProjectId, getCloudProjectBinding } from '@/lib/sync/cloud-project'

/**
 * Aggregate outbox-queue health across ALL FIVE pending-sync tables — shipped
 * in the heartbeat's systemInfo.queueStats so the cloud's fleet-alert sweep
 * (tool_stuck_queue) can see "work is not reaching the cloud" without anyone
 * reading the box's logs. Pre-2.43.1 the heartbeat only carried a flat IO+L2
 * pendingSyncCount; parked rows and queue age were invisible remotely.
 */

/**
 * `hasOrphaned` mirrors queue-inspector's KINDS_WITH_ORPHANED: the e-stop and
 * guided tables carry DeadLettered but NO Orphaned column, so a query that
 * references Orphaned against them throws — and the per-table catch below would
 * then zero out that queue's ENTIRE stats line, not just the one leg. The flag
 * keeps the held-back predicate correct per table instead.
 */
const QUEUES = [
  { table: 'PendingSyncs', hasOrphaned: true },
  { table: 'L2PendingSyncs', hasOrphaned: true },
  { table: 'EStopCheckPendingSyncs', hasOrphaned: false },
  { table: 'GuidedTaskStatePendingSyncs', hasOrphaned: false },
  { table: 'DeviceBlockerPendingSyncs', hasOrphaned: true },
] as const

/**
 * QUEUE-AGE WATCHDOG threshold, in minutes.
 *
 * The outbound queue is supposed to be a few MINUTES deep: auto-sync drains it
 * every 10 s, and a row that cannot be delivered is parked or orphaned within
 * its retry cap. An ACTIVE row older than this is therefore ABNORMAL by
 * definition — it is neither draining nor reaching a terminal state, which is
 * the exact silent-limbo shape that hid the deleted-IO backlog for months.
 *
 * 15 minutes is deliberately generous: it clears a site that has been offline
 * for a coffee break, but not one where work is genuinely not moving.
 *
 * This is a SYMPTOM DETECTOR, not a remediation. Nothing auto-deletes or
 * auto-resolves on the strength of age alone — an old row means someone must
 * LOOK, and age is far too weak a signal to justify hiding field data. It is
 * reported so the cloud can raise it to a human.
 */
export const QUEUE_AGE_WATCHDOG_MINUTES = 15

/**
 * DISPLAY BOUND for the `heldBack` array — NOT a truth bound.
 *
 * The heartbeat ships every ~10 s, so the payload has to stay small; naming the
 * stuck rows is worth bytes, naming ALL of them is not. The counts are computed
 * over the FULL set and shipped alongside (`heldBackTotal`, `heldBackByProject`),
 * so a tablet with 200 held-back rows reports 200 and lists 25. `heldBackTruncated`
 * says so explicitly, so a consumer can never read a short list as the whole set
 * and under-report a backlog.
 *
 * Oldest first, so the 25 shown are the ones that have been stuck longest.
 */
export const HELD_BACK_LIMIT = 25

/**
 * One held-back queue row, named. Counts alone can say THAT work is stuck but
 * never WHICH row or WHY — LastError never left the tablet before this.
 *
 * Deliberately fixed-shape and free of raw error text: see `reason` below.
 */
export interface HeldBackItem {
  /** Which outbound queue: 'io' | 'l2' | 'blocker' | 'estop' | 'guided'. */
  queue: QueueKind
  /**
   * The IO's local id — ONLY for the 'io' queue, where the queue row references
   * a real Ios row. The other four queues key on device/column/zone/task, which
   * are not IOs, so this is null rather than a made-up id.
   */
  ioId: number | null
  /** Display name of the stuck item (IO name, device·MCM, zone, task id). */
  ioName: string
  /** Cloud project, or null when it cannot be established — see cloud-project.ts. */
  projectId: number | null
  /** Owning MCM/subsystem; null on legacy rows that predate per-MCM scoping. */
  subsystemId: number | null
  /** Reused verbatim from queue-inspector.classify — no new vocabulary. */
  classification: Classification
  /** Canonical explanation for `classification`. Never raw cloud text. */
  reason: string
  /** Whole minutes this row has been queued; null if CreatedAt is unreadable. */
  ageMin: number | null
}

export interface QueueStats {
  active: number
  parked: number
  /** Minutes the oldest ACTIVE row has been waiting; 0 when the queue is empty. */
  oldestPendingAgeMin: number
  /**
   * ACTIVE rows older than `staleThresholdMin` — work that is neither draining
   * nor terminating. Non-zero means the queue needs adjudication, NOT that
   * anything has been (or should be) cleared. Counted across all five queues.
   */
  staleActive: number
  /** The threshold `staleActive` was computed against, so the cloud can read the number. */
  staleThresholdMin: number
  byQueue: Record<string, { active: number; parked: number }>
  /**
   * The longest-stuck held-back rows, NAMED. At most HELD_BACK_LIMIT entries.
   * Absent (undefined) when nothing is held back, so the steady-state payload is
   * byte-identical to before. Absent ALSO when the computation failed — read
   * `heldBackTotal` for the count, which comes from the cheap aggregate.
   */
  heldBack?: HeldBackItem[]
  /**
   * TRUE number of held-back rows across all five queues — the count of record.
   * Always present and always accurate, independent of how many are listed.
   *
   * NOT the same as `parked`: this excludes Orphaned-but-unresolved rows, which
   * are parked yet self-heal and so are nobody's outstanding work.
   * `heldBackTotal <= parked` always.
   */
  heldBackTotal: number
  /** True when heldBackTotal exceeds the number of rows actually listed. */
  heldBackTruncated: boolean
  /**
   * Held-back rows per cloud project, over the FULL set (never the truncated
   * list). Keyed by project id as a string; rows whose project cannot be
   * established are counted under 'unattributed' rather than being assigned to
   * a project we merely suspect. Omitted when nothing is held back.
   */
  heldBackByProject?: Record<string, number>
}

export function collectQueueStats(now: Date = new Date()): QueueStats {
  const byQueue: QueueStats['byQueue'] = {}
  let active = 0
  let parked = 0
  let staleActive = 0
  let oldest: number | null = null
  // Cutoff computed against the SAME `now` the ages are reported against, in
  // SQLite's own 'YYYY-MM-DD HH:MM:SS' UTC shape.
  //
  // Compared via julianday(), NOT as text: CreatedAt exists in BOTH the SQLite
  // datetime('now') form ('2026-07-22 10:00:00') and the ISO form the repository
  // writes ('2026-07-22T10:00:00.000Z'). Those two do not sort against each
  // other as strings ('T' > ' '), so a text comparison would silently misjudge
  // every ISO row. julianday parses both as UTC and yields NULL (never a false
  // hit) on anything it cannot read.
  const cutoff = new Date(now.getTime() - QUEUE_AGE_WATCHDOG_MINUTES * 60_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19)
  let heldBackCount = 0
  for (const { table, hasOrphaned } of QUEUES) {
    try {
      // HELD BACK ⊊ PARKED. `parked` is DeadLettered AND NOT Resolved, which
      // still includes rows the cloud confirmed as removed (Orphaned=1) but that
      // have not yet been closed out. Those SELF-HEAL — delta-sync re-queues them
      // if the target reappears — so counting them as held back would raise a
      // "will not sync without action" alarm for work nobody has to touch, which
      // is precisely the false signal this telemetry exists to avoid.
      const heldBackLeg = hasOrphaned
        ? 'DeadLettered = 1 AND Resolved = 0 AND Orphaned = 0'
        : 'DeadLettered = 1 AND Resolved = 0'
      // Resolved rows are terminal (cloud target provably removed) — they are
      // excluded from BOTH legs so the fleet-alert sweep never reports a tablet
      // as having stuck work that no human can or should clear. Resolved ⇒
      // DeadLettered, so only the `parked` leg can actually match one.
      const row = db.prepare(
        `SELECT
           SUM(CASE WHEN DeadLettered = 0 AND Resolved = 0 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN DeadLettered = 1 AND Resolved = 0 THEN 1 ELSE 0 END) AS parked,
           MIN(CASE WHEN DeadLettered = 0 AND Resolved = 0 THEN CreatedAt END) AS oldest,
           SUM(CASE WHEN DeadLettered = 0 AND Resolved = 0
                     AND julianday(CreatedAt) < julianday(?) THEN 1 ELSE 0 END) AS stale,
           SUM(CASE WHEN ${heldBackLeg} THEN 1 ELSE 0 END) AS heldBack
         FROM ${table}`,
      ).get(cutoff) as { active: number | null; parked: number | null; oldest: string | null; stale: number | null; heldBack: number | null }
      const a = row.active ?? 0
      const p = row.parked ?? 0
      byQueue[table] = { active: a, parked: p }
      active += a
      parked += p
      staleActive += row.stale ?? 0
      heldBackCount += row.heldBack ?? 0
      if (row.oldest) {
        const t = Date.parse(`${row.oldest.replace(' ', 'T')}Z`) // SQLite datetime('now') is UTC without zone
        if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t
      }
    } catch {
      // table missing on an old DB — skip, never break the heartbeat
      byQueue[table] = { active: 0, parked: 0 }
    }
  }
  return {
    active,
    parked,
    oldestPendingAgeMin: oldest === null ? 0 : Math.max(0, Math.round((now.getTime() - oldest) / 60000)),
    staleActive,
    staleThresholdMin: QUEUE_AGE_WATCHDOG_MINUTES,
    byQueue,
    // The total comes from the plain COUNT above, computed with the SAME
    // predicate the list uses, so it cannot fail with the enrichment: if naming
    // the rows throws, the cloud still learns how many there are.
    ...collectHeldBackSafe(heldBackCount),
  }
}

/**
 * Name the held-back rows, and never let doing so cost us the counts.
 *
 * TELEMETRY MUST NEVER BREAK SYNCING. system-info already wraps the whole
 * collector, but that wrapper drops ALL queueStats on a throw — losing the
 * counts because an enrichment failed. This inner guard keeps the failure
 * local: on any error the caller still returns active/parked/stale plus a
 * truthful heldBackTotal, just without the named list.
 */
function collectHeldBackSafe(
  heldBackCount: number,
): Pick<QueueStats, 'heldBack' | 'heldBackTotal' | 'heldBackTruncated' | 'heldBackByProject'> {
  // Overwhelmingly the common case: nothing is stuck. Skip the scan entirely so
  // a healthy tablet's heartbeat is byte-for-byte what it was before this change.
  if (heldBackCount <= 0) return { heldBackTotal: 0, heldBackTruncated: false }

  try {
    // Reuse the Sync Center's own read+triage layer rather than restating its
    // SQL: it already resolves every queue's display name, owning subsystem and
    // age, applies classify() (the one classifier — no new regexes here), and
    // correctly treats the e-stop/guided tables that have no Orphaned column.
    //
    // 'parked' is exactly "held back": DeadLettered, NOT orphaned, NOT resolved
    // — the bucket that will not move without a human. Orphaned rows self-heal
    // and resolved rows are terminal, so neither is anyone's outstanding work.
    const items = listQueue({ status: 'parked' }).items
    const binding = getCloudProjectBinding()

    // Rollup over the FULL set, before any truncation, so the per-project counts
    // stay true even though the list below is capped.
    const byProject: Record<string, number> = {}
    for (const it of items) {
      const pid = attributeProjectId(it.createdAt, binding)
      byProject[pid == null ? 'unattributed' : String(pid)] =
        (byProject[pid == null ? 'unattributed' : String(pid)] ?? 0) + 1
    }

    // Oldest first — if only 25 can be named, name the ones stuck longest.
    // listQueue already sorts parked rows by descending age; sort defensively
    // so this does not silently depend on that ordering.
    const ordered = [...items].sort((a, b) => (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1))
    const heldBack: HeldBackItem[] = ordered.slice(0, HELD_BACK_LIMIT).map((it) => ({
      queue: it.kind,
      // The IO's OWN id, never the queue row's — see QueueItem.ioId. Emitting a
      // queue-row id under the name `ioId` would hand the cloud an id that looks
      // resolvable and silently resolves to the wrong IO (or none).
      ioId: it.ioId,
      ioName: it.title,
      projectId: attributeProjectId(it.createdAt, binding),
      subsystemId: it.subsystemId,
      classification: it.classification,
      // The CANONICAL text for the classification, NOT it.reason: classify()
      // appends the raw LastError ("… (Cloud said: <verbatim>)") for the
      // cloud_rejected/unknown cases, and LastError is arbitrary cloud- or
      // exception-authored free text (it can carry the remote URL and whatever
      // string /api/sync/update chose to return). That belongs in the Sync
      // Center on the tablet, where it is already shown; it is not something to
      // start shipping off-box every 10 s. The bounded enum plus this fixed
      // sentence carry the meaning without the unbounded payload.
      reason: REASONS[it.classification],
      ageMin: it.ageMinutes,
    }))

    // The list is capped; the TOTAL is not. Prefer the caller's aggregate count
    // and fall back to the scan's own length only if they disagree — they are
    // the same predicate, so a mismatch means rows changed between the two
    // reads, and the larger (more alarming) number is the safer one to report.
    const total = Math.max(heldBackCount, items.length)
    return {
      heldBack,
      heldBackTotal: total,
      heldBackTruncated: total > heldBack.length,
      heldBackByProject: byProject,
    }
  } catch (e) {
    console.warn('[QueueStats] held-back detail unavailable:', (e as Error)?.message || e)
    // Counts survive; only the names are lost.
    return { heldBackTotal: heldBackCount, heldBackTruncated: heldBackCount > 0 }
  }
}
