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
    const localTs = row.Timestamp ? Date.parse(row.Timestamp) : NaN
    // No local timestamp → cannot establish local is newer; don't block.
    if (!Number.isFinite(localTs)) continue
    const cloudTs = cloud.timestamp ? Date.parse(cloud.timestamp) : NaN
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
