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
