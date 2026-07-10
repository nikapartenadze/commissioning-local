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
