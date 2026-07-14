/**
 * Per-MCM FV column applicability (2026-07-14): a column shows on an MCM's FV
 * page only when it applies to that MCM. NULL/empty = all MCMs (backward
 * compatible). Presentation-only — the field never deletes cell values, so a
 * column becoming non-applicable loses no data (verified separately in the
 * pull-l2 non-destructive tests). Born from the CDW5 "Tracking Fault (SCADA)
 * only applies to MCM11" request.
 */
import { describe, it, expect } from 'vitest'
import { fvColumnAppliesToMcms } from '@/lib/fv-utils'

describe('fvColumnAppliesToMcms', () => {
  it('empty/null applies to ALL MCMs (every existing column, unchanged)', () => {
    expect(fvColumnAppliesToMcms(null, ['MCM04'])).toBe(true)
    expect(fvColumnAppliesToMcms(undefined, ['MCM11'])).toBe(true)
    expect(fvColumnAppliesToMcms('', ['MCM04'])).toBe(true)
    expect(fvColumnAppliesToMcms('   ', ['MCM04'])).toBe(true)
  })

  it('scoped column shows only on its MCM (the Tracking Fault / MCM11 case)', () => {
    expect(fvColumnAppliesToMcms('MCM11', ['MCM11'])).toBe(true)
    expect(fvColumnAppliesToMcms('MCM11', ['MCM04'])).toBe(false)
    expect(fvColumnAppliesToMcms('MCM11', ['MCM01', 'MCM02'])).toBe(false)
  })

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(fvColumnAppliesToMcms('mcm11', ['MCM11'])).toBe(true)
    expect(fvColumnAppliesToMcms(' MCM11 ', ['mcm11'])).toBe(true)
  })

  it('supports a multi-MCM list', () => {
    expect(fvColumnAppliesToMcms('MCM11,MCM12', ['MCM12'])).toBe(true)
    expect(fvColumnAppliesToMcms('MCM11, MCM12', ['MCM13'])).toBe(false)
  })

  it('a page with no MCM labels hides a scoped column (nothing to match)', () => {
    expect(fvColumnAppliesToMcms('MCM11', [])).toBe(false)
    expect(fvColumnAppliesToMcms('MCM11', ['', '  '])).toBe(false)
  })
})
