// Pure, dependency-light helpers for the enhanced IO data grid. Extracted
// verbatim from enhanced-io-data-grid.tsx. None of these close over component
// state — they only take their arguments.

import type { IoItem } from "./types"

/**
 * Mirror of server-side checkInstallGate. Returns true when the install-status
 * gate would block a Pass/Fail attempt on this IO. SPARE IOs are exempt to
 * match the server. Kept inline (rather than in a shared module) because the
 * grid sees the lowercase API shape, not the SQLite PascalCase Io type.
 */
export function isBlockedByInstallGate(io: IoItem, gateActive: boolean): boolean {
  if (!gateActive) return false
  const desc = (io.description ?? '').toUpperCase()
  if (desc.includes('SPARE')) return false
  return (io.installationStatus ?? '').toLowerCase() !== 'complete'
}

// Natural sort: "X2" before "X10", "UL26_19" before "UL26_20".
export function naturalCompare(a: string, b: string): number {
  const ax = (a || '').match(/(\d+)|(\D+)/g) || []
  const bx = (b || '').match(/(\d+)|(\D+)/g) || []
  const len = Math.min(ax.length, bx.length)
  for (let i = 0; i < len; i++) {
    const av = ax[i]
    const bv = bx[i]
    const an = /^\d+$/.test(av)
    const bn = /^\d+$/.test(bv)
    if (an && bn) {
      const d = parseInt(av, 10) - parseInt(bv, 10)
      if (d !== 0) return d
    } else if (av !== bv) {
      return av < bv ? -1 : 1
    }
  }
  return ax.length - bx.length
}

// Install sort: complete sinks below in-progress so "what still needs work"
// floats to the top in ascending order. Unknown percent counts as 0.
export function installRank(io: IoItem): number {
  if ((io.installationStatus ?? '').toLowerCase() === 'complete') return 101
  return io.installationPercent ?? 0
}

// Top-level lane = leading "UL<digits>" prefix. Everything else → "Other".
export function extractLane(name: string): string {
  const m = (name || '').match(/^(UL\d+)/i)
  return m ? m[1].toUpperCase() : 'Other'
}

// UL lanes by numeric id ascending, "Other" last.
export function compareLanes(a: string, b: string): number {
  if (a === b) return 0
  if (a === 'Other') return 1
  if (b === 'Other') return -1
  const an = parseInt(a.replace(/^UL/i, ''), 10)
  const bn = parseInt(b.replace(/^UL/i, ''), 10)
  if (!isNaN(an) && !isNaN(bn)) return an - bn
  return a < b ? -1 : 1
}

// ── Planned-date filter (cloud-owned schedule; field read-only) ──────────────

export type PlannedFilter = 'all' | 'overdue' | 'today' | 'week' | 'has' | 'none'

// Local calendar date as "YYYY-MM-DD". String-built (no toISOString) so the
// electrician's local day is used, not UTC's.
function toLocalIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Today + the Monday–Sunday week containing it, as "YYYY-MM-DD" strings. */
export function plannedDateBounds(now: Date = new Date()): { today: string; weekStart: string; weekEnd: string } {
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7)) // back to Monday
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)
  return { today: toLocalIsoDate(now), weekStart: toLocalIsoDate(weekStart), weekEnd: toLocalIsoDate(weekEnd) }
}

/**
 * Planned-date predicate for the grid filter. `plannedDate` is the cloud's
 * "YYYY-MM-DD" string (or null); ISO date strings compare correctly as plain
 * strings, so no Date parsing (and no timezone drift) is involved. A specific
 * `exactDate` (from the date input) takes precedence over the bucket filter.
 */
export function matchesPlannedFilter(
  plannedDate: string | null | undefined,
  filter: PlannedFilter,
  exactDate: string,
  bounds: { today: string; weekStart: string; weekEnd: string },
): boolean {
  const pd = plannedDate || null
  if (exactDate) return pd === exactDate
  switch (filter) {
    case 'all': return true
    case 'has': return pd !== null
    case 'none': return pd === null
    case 'overdue': return pd !== null && pd < bounds.today
    case 'today': return pd === bounds.today
    case 'week': return pd !== null && pd >= bounds.weekStart && pd <= bounds.weekEnd
  }
}

// Render a planned date ("YYYY-MM-DD") as MM/DD/YY, matching the compact style
// of date-range-filter's formatDateForFilter. Pure string slicing — no Date
// object, so the calendar date can't shift across timezones. Malformed input
// is shown verbatim rather than hidden.
export function formatPlannedDate(pd: string | null | undefined): string | null {
  if (!pd) return null
  const m = pd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return pd
  return `${m[2]}/${m[3]}/${m[1].slice(-2)}`
}
