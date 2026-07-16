/**
 * Result-loss guard for the destructive manual pull (DELETE FROM Ios +
 * reinsert cloud state).
 *
 * Second line of defense after the pending-queue check: in the 2026-06-04
 * TPA8/MCM08 incident the retry cap silently emptied PendingSyncs while the
 * site was offline, so the queue check saw 0 rows and let the pull erase
 * 818 unsynced results. This guard doesn't trust the queue — it compares
 * the actual local results against the actual cloud payload.
 */

export interface LocalResultRow {
  id: number
  Name: string
  Result: string
}

export interface AtRiskResult {
  id: number
  name: string
  result: string
}

/**
 * Returns local results that the destructive pull would erase: rows where
 * local has a Pass/Fail/etc. but the cloud payload has no result at all
 * (IO missing from payload, or result null/empty).
 *
 * A *different* cloud result is NOT at risk — that's normal multi-user
 * last-write-wins, and the cloud value is the newer authority there.
 */
export function computeAtRiskResults(
  localWithResults: LocalResultRow[],
  cloudIos: Array<{ id: number | string; result?: string | null }>,
): AtRiskResult[] {
  const cloudResultById = new Map<number, string | null>(
    cloudIos.map(io => [Number(io.id), (io.result ?? null) as string | null])
  )
  return localWithResults
    .filter(row => {
      const cloudResult = cloudResultById.get(row.id)
      return cloudResult == null || cloudResult === ''
    })
    .map(row => ({ id: row.id, name: row.Name, result: row.Result }))
}

export interface LocalCommentRow {
  id: number
  Name: string
  Comments: string
}

export interface AtRiskComment {
  id: number
  name: string
}

/**
 * B2: the destructive pull also wipes local COMMENTS (DELETE FROM Ios drops
 * them before the cloud rows are inserted). The old warning counted only
 * Result rows, so unsynced field comments could vanish without a mention.
 * Returns local IOs that carry a comment the cloud payload lacks.
 */
export function computeAtRiskComments(
  localWithComments: LocalCommentRow[],
  cloudIos: Array<{ id: number | string; comments?: string | null }>,
): AtRiskComment[] {
  const cloudCommentById = new Map<number, string | null>(
    cloudIos.map(io => [Number(io.id), (io.comments ?? null) as string | null])
  )
  return localWithComments
    .filter(row => {
      if (!row.Comments || row.Comments.trim() === '') return false
      const cloudComment = cloudCommentById.get(row.id)
      return cloudComment == null || cloudComment.trim() === ''
    })
    .map(row => ({ id: row.id, name: row.Name }))
}

export interface LocalClearedRow {
  id: number
  Name: string
  /** When the operator cleared it (latest 'Cleared' TestHistories.Timestamp). */
  clearedAt: string | null
}

export interface AtRiskClear {
  id: number
  name: string
  cloudResult: string
}

/**
 * F-reset (2026-07-08 "checks keep getting reset" incident, MCM04): the
 * destructive pull (DELETE FROM Ios + reinsert cloud state) also silently
 * REVERTS a deliberate operator CLEAR. A cleared IO has Result=NULL, so it is
 * invisible to computeAtRiskResults / computeDivergentUnqueuedResults (both
 * require a non-null local Result). When the cloud still holds the old
 * Passed/Failed at an inflated version (the local clear lost the version race
 * and never propagated), every pull reinserts that stale value — the operator
 * clears it, the pull brings it back, ad infinitum.
 *
 * This flags IOs the operator recently and deliberately cleared (latest
 * TestHistories row is 'Cleared') where the cloud payload still carries a
 * non-null result that is NOT provably newer than the clear. A cloud value that
 * is provably newer than the clear (real later edit) is NOT flagged — normal
 * last-write-wins still applies. Rows with a pending/queued clear are handled by
 * the pending-queue guard and pass through here harmlessly (still flagged, which
 * only makes the pull refuse — never destructive).
 */
export function computeAtRiskClears(
  localClearedRows: LocalClearedRow[],
  cloudIos: Array<{ id: number | string; result?: string | null; timestamp?: string | null }>,
): AtRiskClear[] {
  const cloudById = new Map<number, { result: string | null; timestamp: string | null }>(
    cloudIos.map(io => [
      Number(io.id),
      { result: (io.result ?? null) as string | null, timestamp: (io.timestamp ?? null) as string | null },
    ])
  )
  const out: AtRiskClear[] = []
  for (const row of localClearedRows) {
    const cloud = cloudById.get(row.id)
    // Cloud has no result → the pull wouldn't restore anything; nothing at risk.
    if (!cloud || cloud.result == null || cloud.result === '') continue
    const clearedAt = parseDbTimestamp(row.clearedAt)
    // No clear timestamp → cannot prove the clear is the newer intent; leave it
    // to the other guards (don't over-block).
    if (!Number.isFinite(clearedAt)) continue
    const cloudTs = Date.parse(cloud.timestamp ?? '')
    // Cloud is provably newer than the clear → a real later edit wins; not at risk.
    if (Number.isFinite(cloudTs) && cloudTs > clearedAt) continue
    out.push({ id: row.id, name: row.Name, cloudResult: cloud.result })
  }
  return out
}

export interface LocalResultRowWithTs {
  id: number
  Name: string
  Result: string
  Timestamp?: string | null
}

export interface DivergentUnqueuedResult {
  id: number
  name: string
  localResult: string
  cloudResult: string
  localTimestamp: string | null
  cloudTimestamp: string | null
}

/**
 * Third line of defense (2026-07-03 sync audit, F2): the checks above only
 * cover "cloud has NO result", but the MCM08 failure shape can also present
 * as a *different, stale* cloud value — the retry cap empties the queue,
 * the cloud still holds an OLDER result, and the destructive pull silently
 * replaces the newer local truth. "Different cloud result" is only normal
 * last-write-wins when the cloud is actually newer, so this flags rows where
 * ALL of:
 *   - local and cloud results are both set and DIFFER,
 *   - the IO has NO pending/parked queue row (queued rows already block the
 *     pull outright), and
 *   - the local Timestamp is strictly newer than the cloud timestamp, or the
 *     cloud row carries no timestamp at all (no evidence it is newer).
 * Rows where the cloud is provably newer — or where local has no timestamp to
 * prove anything — remain normal multi-user last-write-wins and are NOT
 * flagged, so routine merges keep working.
 */
export interface LocalL2Cell {
  /** L2Devices.CloudId — null for unmapped local-only devices. */
  deviceCloudId: number | null
  /** L2Columns.CloudId — null for unmapped columns. */
  columnCloudId: number | null
  deviceName: string | null
  columnName: string | null
  value: string
  /** L2CellValues.UpdatedAt — SQLite datetime('now') format (UTC, no zone). */
  updatedAt: string | null
}

export interface AtRiskL2Cell {
  deviceCloudId: number | null
  columnCloudId: number | null
  deviceName: string | null
  columnName: string | null
  localValue: string
  cloudValue: string | null
  reason: 'cloud-missing' | 'local-newer' | 'unmapped'
}

/**
 * SQLite's datetime('now') emits "YYYY-MM-DD HH:MM:SS" in UTC but WITHOUT a
 * zone marker, which Date.parse would interpret as LOCAL time — a silent
 * multi-hour skew. Normalize that shape to an explicit UTC ISO string before
 * comparing against the cloud's ISO timestamps.
 */
export function parseDbTimestamp(ts: string | null | undefined): number {
  if (!ts) return NaN
  const sqliteShape = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
  return Date.parse(sqliteShape.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts)
}

/**
 * F5 (2026-07-03 sync audit): result-loss guard for the destructive FV/L2
 * pull (pull-l2 DELETEs this subsystem's devices+cells and reinserts cloud
 * state). Flags local cell values the pull would destroy:
 *   - 'unmapped'      — the cell's device/column has no CloudId; the delete
 *                       removes it and the reinsert can never restore it.
 *   - 'cloud-missing' — the cloud payload carries no value for this cell.
 *   - 'local-newer'   — values differ and the local edit is newer than the
 *                       cloud's (or the cloud value has no timestamp).
 * Cells with a pending queue row are skipped — the pending-queue guard
 * already blocks the pull outright for those.
 */
export function computeAtRiskL2Cells(
  localCells: LocalL2Cell[],
  cloudCells: Array<{ deviceId: number | string; columnId: number | string; value?: string | null; updatedAt?: string | null }>,
  queuedKeys: Set<string>,
): AtRiskL2Cell[] {
  const cloudByKey = new Map<string, { value: string | null; updatedAt: string | null }>(
    cloudCells.map(c => [
      `${Number(c.deviceId)}-${Number(c.columnId)}`,
      { value: (c.value ?? null) as string | null, updatedAt: (c.updatedAt ?? null) as string | null },
    ])
  )
  const out: AtRiskL2Cell[] = []
  for (const cell of localCells) {
    if (!cell.value || cell.value.trim() === '') continue
    const base = {
      deviceCloudId: cell.deviceCloudId,
      columnCloudId: cell.columnCloudId,
      deviceName: cell.deviceName,
      columnName: cell.columnName,
      localValue: cell.value,
    }
    if (cell.deviceCloudId == null || cell.columnCloudId == null) {
      out.push({ ...base, cloudValue: null, reason: 'unmapped' })
      continue
    }
    if (queuedKeys.has(`${cell.deviceCloudId}-${cell.columnCloudId}`)) continue
    const cloud = cloudByKey.get(`${cell.deviceCloudId}-${cell.columnCloudId}`)
    if (!cloud || cloud.value == null || cloud.value.trim() === '') {
      out.push({ ...base, cloudValue: cloud?.value ?? null, reason: 'cloud-missing' })
      continue
    }
    if (cloud.value === cell.value) continue
    const localTs = parseDbTimestamp(cell.updatedAt)
    if (!Number.isFinite(localTs)) continue // cannot establish local is newer
    const cloudTs = parseDbTimestamp(cloud.updatedAt)
    if (Number.isFinite(cloudTs) && cloudTs >= localTs) continue
    out.push({ ...base, cloudValue: cloud.value, reason: 'local-newer' })
  }
  return out
}

// ── Route-level composition (D5) ─────────────────────────────────────────────
// The full at-risk / divergent / clear guard + 409 refuse block was duplicated
// verbatim in /api/cloud/pull and /api/mcm/[subsystemId]/pull, so every guard
// fix (F2, R10, F-reset) had to land twice. computePullRiskOrRefuse below runs
// the identical DB reads + the four compute* functions above and builds the
// exact 409 the routes returned inline, driven by `scope`:
//   - scope.subsystemId === null → the legacy global pull: unscoped queries and
//     the generic refuse message.
//   - scope.subsystemId === <n>  → the per-MCM pull: SubsystemId-scoped queries
//     and the "exist locally for MCM <n>" refuse message.
// Pure extraction — no behavior change; the response SHAPE is identical for both
// and each route's exact log/error text is reproduced per scope.

/** Minimal better-sqlite3 surface the guard needs — decouples it from db-sqlite. */
interface PullGuardDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
}

export interface PullGuardScope {
  db: PullGuardDb
  /** null → legacy global pull (unscoped); a number → per-MCM scoped pull. */
  subsystemId: number | null
  /** Console prefix, matching each route's existing log tag. */
  logPrefix: string
}

export interface PullRiskDecision {
  /** Non-null → the caller must return res.status(status).json(body). */
  refuse: { status: number; body: Record<string, unknown> } | null
  atRisk: AtRiskResult[]
  atRiskComments: AtRiskComment[]
  divergent: DivergentUnqueuedResult[]
  atRiskClears: AtRiskClear[]
}

/**
 * Second/third line of defense for the destructive pull: compares the ACTUAL
 * local results/comments/clears against the ACTUAL cloud payload (never trusting
 * the pending queue, which the retry cap can silently empty) and refuses with a
 * 409 when the pull would erase unsynced field work — unless `force` is set.
 *
 * Returns the computed risk arrays either way so the caller can log the FORCE
 * override, decide whether a backup is mandatory, and record the audit trail.
 */
export function computePullRiskOrRefuse(
  scope: PullGuardScope,
  cloudIos: Array<{ id: number | string; result?: string | null; comments?: string | null; timestamp?: string | null }>,
  force: boolean,
): PullRiskDecision {
  const { db, subsystemId, logPrefix } = scope
  const scoped = subsystemId !== null

  // COALESCE(CloudRemoved,0)=0 excludes tombstoned IOs — ones the cloud
  // permanently removed (403/404/410) or the operator accepted as unsyncable.
  // A destructive pull can't lose anything meaningful for a cloud-deleted IO, so
  // it must NOT count toward "would erase" (that's what warned forever).
  const localWithResults = (
    scoped
      ? db.prepare(
          `SELECT id, Name, Result, Timestamp FROM Ios WHERE SubsystemId = ? AND Result IS NOT NULL AND Result != '' AND COALESCE(CloudRemoved,0) = 0`,
        ).all(subsystemId)
      : db.prepare(
          `SELECT id, Name, Result, Timestamp FROM Ios WHERE Result IS NOT NULL AND Result != '' AND COALESCE(CloudRemoved,0) = 0`,
        ).all()
  ) as Array<{ id: number; Name: string; Result: string; Timestamp: string | null }>
  const atRisk = computeAtRiskResults(localWithResults, cloudIos)

  const localWithComments = (
    scoped
      ? db.prepare(
          `SELECT id, Name, Comments FROM Ios WHERE SubsystemId = ? AND Comments IS NOT NULL AND TRIM(Comments) != '' AND COALESCE(CloudRemoved,0) = 0`,
        ).all(subsystemId)
      : db.prepare(
          `SELECT id, Name, Comments FROM Ios WHERE Comments IS NOT NULL AND TRIM(Comments) != '' AND COALESCE(CloudRemoved,0) = 0`,
        ).all()
  ) as Array<{ id: number; Name: string; Comments: string }>
  const atRiskComments = computeAtRiskComments(localWithComments, cloudIos)

  const queuedIoIds = new Set(
    (
      scoped
        ? db.prepare(
            `SELECT ps.IoId FROM PendingSyncs ps JOIN Ios i ON i.id = ps.IoId WHERE i.SubsystemId = ?`,
          ).all(subsystemId)
        : db.prepare('SELECT IoId FROM PendingSyncs').all()
    ).map((r) => (r as { IoId: number }).IoId),
  )
  const divergent = computeDivergentUnqueuedResults(localWithResults, cloudIos, queuedIoIds)

  const localCleared = (
    scoped
      ? db.prepare(
          `SELECT i.id AS id, i.Name AS Name,
            (SELECT th.Result    FROM TestHistories th WHERE th.IoId = i.id ORDER BY th.id DESC LIMIT 1) AS lastResult,
            (SELECT th.Timestamp FROM TestHistories th WHERE th.IoId = i.id ORDER BY th.id DESC LIMIT 1) AS clearedAt
           FROM Ios i
           WHERE i.SubsystemId = ? AND (i.Result IS NULL OR i.Result = '')`,
        ).all(subsystemId)
      : db.prepare(
          `SELECT i.id AS id, i.Name AS Name,
            (SELECT th.Result    FROM TestHistories th WHERE th.IoId = i.id ORDER BY th.id DESC LIMIT 1) AS lastResult,
            (SELECT th.Timestamp FROM TestHistories th WHERE th.IoId = i.id ORDER BY th.id DESC LIMIT 1) AS clearedAt
           FROM Ios i WHERE (i.Result IS NULL OR i.Result = '')`,
        ).all()
  ) as Array<{ id: number; Name: string; lastResult: string | null; clearedAt: string | null }>
  const atRiskClears = computeAtRiskClears(
    localCleared.filter((r) => r.lastResult === 'Cleared').map((r) => ({ id: r.id, Name: r.Name, clearedAt: r.clearedAt })),
    cloudIos,
  )

  const hasRisk = atRisk.length > 0 || atRiskComments.length > 0 || divergent.length > 0 || atRiskClears.length > 0

  if (hasRisk && !force) {
    const sample = [...atRisk, ...divergent, ...atRiskClears].slice(0, 5).map((r) => r.name).join(', ')
    console.warn(
      `${logPrefix} REFUSED: pull would erase ${atRisk.length} local result(s), ` +
      `${atRiskComments.length} local comment(s) the cloud does not have, overwrite ` +
      `${divergent.length} newer local result(s) that differ from stale cloud values, and ` +
      `revert ${atRiskClears.length} deliberate local clear(s)` +
      (scoped ? ' the cloud still holds a stale value for ' : ' ') +
      `(e.g. ${sample}). ` +
      'Resend with force=true to override.',
    )
    const parts = [
      atRisk.length > 0 ? `${atRisk.length} test result(s) the cloud lacks` : null,
      atRiskComments.length > 0 ? `${atRiskComments.length} comment(s) the cloud lacks` : null,
      divergent.length > 0 ? `${divergent.length} newer local result(s) that differ from stale cloud values` : null,
      atRiskClears.length > 0 ? `${atRiskClears.length} deliberate local clear(s) the cloud would revert` : null,
    ].filter(Boolean).join(', ')
    const error = scoped
      ? `Pull refused: ${parts} exist locally for MCM ${subsystemId} — ` +
        'pulling now would erase them. They are likely unsynced field work. ' +
        'Sync first, or confirm the overwrite to proceed. (A pre-pull backup is taken regardless.)'
      : `Pull refused: ${parts} — pulling now would erase them. ` +
        'They are likely unsynced field work. ' +
        'Sync first, or confirm the overwrite to proceed. (A pre-pull backup is taken regardless.)'
    return {
      refuse: {
        status: 409,
        body: {
          success: false,
          requiresForce: true,
          wouldLoseResults: atRisk.length,
          wouldLoseComments: atRiskComments.length,
          wouldOverwriteNewerLocal: divergent.length,
          wouldRevertClears: atRiskClears.length,
          atRiskSample: atRisk.slice(0, 10),
          atRiskCommentSample: atRiskComments.slice(0, 10),
          divergentSample: divergent.slice(0, 10),
          atRiskClearSample: atRiskClears.slice(0, 10),
          error,
        },
      },
      atRisk,
      atRiskComments,
      divergent,
      atRiskClears,
    }
  }

  if (hasRisk) {
    console.warn(
      `${logPrefix} FORCE override: erasing ${atRisk.length} result(s) + ` +
      `${atRiskComments.length} comment(s) + overwriting ${divergent.length} newer divergent result(s) + ` +
      `reverting ${atRiskClears.length} deliberate clear(s) (user confirmed)`,
    )
  }

  return { refuse: null, atRisk, atRiskComments, divergent, atRiskClears }
}

export function computeDivergentUnqueuedResults(
  localRows: LocalResultRowWithTs[],
  cloudIos: Array<{ id: number | string; result?: string | null; timestamp?: string | null }>,
  queuedIoIds: Set<number>,
): DivergentUnqueuedResult[] {
  const cloudById = new Map<number, { result: string | null; timestamp: string | null }>(
    cloudIos.map(io => [
      Number(io.id),
      { result: (io.result ?? null) as string | null, timestamp: (io.timestamp ?? null) as string | null },
    ])
  )
  const out: DivergentUnqueuedResult[] = []
  for (const row of localRows) {
    if (!row.Result || row.Result === '') continue
    if (queuedIoIds.has(row.id)) continue
    const cloud = cloudById.get(row.id)
    // Cloud missing / empty result → computeAtRiskResults already covers it.
    if (!cloud || cloud.result == null || cloud.result === '') continue
    if (cloud.result === row.Result) continue
    // Use parseDbTimestamp (not raw Date.parse): a local Timestamp in SQLite's
    // zone-less datetime('now') shape would otherwise be read as LOCAL time and
    // skew the comparison by the machine's UTC offset — the exact bug this guard
    // must not have. parseDbTimestamp normalizes that shape to UTC and passes
    // ISO strings through unchanged. Matches computeAtRiskClears above.
    const localTs = parseDbTimestamp(row.Timestamp)
    // No local timestamp → cannot establish local is newer; don't block.
    if (!Number.isFinite(localTs)) continue
    const cloudTs = parseDbTimestamp(cloud.timestamp)
    if (Number.isFinite(cloudTs) && cloudTs >= localTs) continue
    out.push({
      id: row.id,
      name: row.Name,
      localResult: row.Result,
      cloudResult: cloud.result,
      localTimestamp: row.Timestamp ?? null,
      cloudTimestamp: cloud.timestamp ?? null,
    })
  }
  return out
}
