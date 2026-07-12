/**
 * Merge local TestHistories rows with the cloud's per-IO history.
 *
 * WHY THIS EXISTS: since the delta-sync pipeline replaced routine destructive
 * full pulls (2026-07-10), TestHistories rows stopped flowing cloud → field —
 * the delta payload carries IO upserts only, and pull-core's history sync
 * (step 4) now only runs on the rare bootstrap/fallback full pull. Result:
 * a tablet's local TestHistories contains ONLY the actions performed on that
 * machine, so the per-IO Test History dialog looked empty/stale for anything
 * done by another operator, another tablet, or the cloud UI ("who failed
 * this?", "who marked it Addressed?" showed nothing).
 *
 * The fix is a read-time merge: the field /api/history/:ioId route fetches
 * the cloud's authoritative per-IO history (every tablet pushes its results
 * there) and merges it with the local rows. Offline → local rows only, same
 * as before.
 *
 * Dedup: a local action is normally ALSO present in the cloud response (the
 * instant push created a cloud testhistories row), but the two copies do not
 * share ids and their timestamps can differ by a few ms (the local row and
 * the PendingSyncs row are stamped separately). Two rows are treated as the
 * same event when the result matches, the timestamps are within
 * DEDUP_WINDOW_MS, and the testedBy values are compatible (equal, or one
 * side is a generic placeholder like 'API'/'Unknown'). The LOCAL copy wins
 * (it carries failureMode), but a generic local testedBy is upgraded to the
 * cloud's named one.
 */

export interface MergedHistoryEntry {
  id: number
  ioId: number
  result: string | null
  testedBy: string | null
  timestamp: string | null
  failureMode?: string | null
  state: string | null
  comments: string | null
  /** Where the surviving copy came from. Cloud rows are other tablets' /
   *  cloud-UI actions that never existed in this machine's SQLite. */
  source: 'local' | 'cloud'
}

export type LocalHistoryInput = Omit<MergedHistoryEntry, 'source'> & Record<string, unknown>
export interface CloudHistoryInput {
  id: number
  ioId: number
  result: string | null
  testedBy: string | null
  timestamp: string | null
  state?: string | null
  comments?: string | null
  failureMode?: string | null
  /** Subsystem-wide feeds also carry ioName/ioDescription/subsystemName —
   *  preserved verbatim on the merged row (the All Test History dialog
   *  renders them). */
  [extra: string]: unknown
}

const DEDUP_WINDOW_MS = 5_000

/** testedBy values that carry no attribution — never block a dedup match. */
const GENERIC_TESTED_BY = new Set(['', 'api', 'unknown'])

function isGenericTestedBy(v: string | null | undefined): boolean {
  return GENERIC_TESTED_BY.has((v ?? '').trim().toLowerCase())
}

function testedByCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (isGenericTestedBy(a) || isGenericTestedBy(b)) return true
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
}

function epoch(ts: string | null | undefined): number {
  if (!ts) return NaN
  return Date.parse(ts)
}

/**
 * Merge local + cloud history for one IO. Returns rows sorted newest-first,
 * capped at `limit`. Rows with unparsable timestamps are kept (never silently
 * dropped — this is an audit trail) and sort after parsable ones.
 */
export function mergeHistories(
  local: LocalHistoryInput[],
  cloud: CloudHistoryInput[],
  limit = 100,
): MergedHistoryEntry[] {
  const merged: MergedHistoryEntry[] = local.map((l) => ({ ...l, source: 'local' as const }))

  for (const c of cloud) {
    const cMs = epoch(c.timestamp)
    const dup = merged.find((m) => {
      if (m.source !== 'local') return false
      // ioId must match — the subsystem-wide (All Test History) merge runs
      // over many IOs, and near-simultaneous same-result events on DIFFERENT
      // IOs are distinct entries. No-op for the per-IO merge.
      if (m.ioId !== c.ioId) return false
      if ((m.result ?? '') !== (c.result ?? '')) return false
      if (!testedByCompatible(m.testedBy, c.testedBy)) return false
      const mMs = epoch(m.timestamp)
      if (Number.isNaN(mMs) || Number.isNaN(cMs)) return false
      return Math.abs(mMs - cMs) <= DEDUP_WINDOW_MS
    })
    if (dup) {
      // Local copy survives; take the cloud's named attribution if ours is generic.
      if (isGenericTestedBy(dup.testedBy) && !isGenericTestedBy(c.testedBy)) {
        dup.testedBy = c.testedBy
      }
      continue
    }
    merged.push({
      // Spread first: subsystem-wide feeds carry ioName/ioDescription/
      // subsystemName, which must survive onto the merged row.
      ...c,
      id: c.id,
      ioId: c.ioId,
      result: c.result ?? null,
      testedBy: c.testedBy ?? null,
      timestamp: c.timestamp ?? null,
      failureMode: c.failureMode ?? null,
      state: c.state ?? null,
      comments: c.comments ?? null,
      source: 'cloud',
    })
  }

  merged.sort((a, b) => {
    const aMs = epoch(a.timestamp)
    const bMs = epoch(b.timestamp)
    const aBad = Number.isNaN(aMs)
    const bBad = Number.isNaN(bMs)
    if (aBad && bBad) return 0
    if (aBad) return 1
    if (bBad) return -1
    return bMs - aMs
  })

  return merged.slice(0, limit)
}
