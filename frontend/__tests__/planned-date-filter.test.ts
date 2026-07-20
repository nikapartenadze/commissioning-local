/**
 * Planned-date grid filter helpers (components/enhanced-io-data-grid/helpers).
 * Pure string-date logic — the grid's electrician-facing "Overdue / Today /
 * This week / Has date / No date (+ exact date)" filter and the MM/DD/YY
 * renderer. All comparisons are on "YYYY-MM-DD" strings, never Date-parsed,
 * so no timezone can shift a calendar day.
 */
import { describe, it, expect } from 'vitest'
import { matchesPlannedFilter, plannedDateBounds, formatPlannedDate } from '@/components/enhanced-io-data-grid/helpers'

// Wed 2026-07-22 → week is Mon 2026-07-20 .. Sun 2026-07-26.
const bounds = plannedDateBounds(new Date(2026, 6, 22))

describe('plannedDateBounds', () => {
  it('computes today + the Monday–Sunday week around it (local dates)', () => {
    expect(bounds).toEqual({ today: '2026-07-22', weekStart: '2026-07-20', weekEnd: '2026-07-26' })
  })

  it('a Monday is its own weekStart; a Sunday keeps the preceding Monday', () => {
    expect(plannedDateBounds(new Date(2026, 6, 20)).weekStart).toBe('2026-07-20')
    expect(plannedDateBounds(new Date(2026, 6, 26))).toEqual({ today: '2026-07-26', weekStart: '2026-07-20', weekEnd: '2026-07-26' })
  })
})

describe('matchesPlannedFilter', () => {
  it("'all' passes everything", () => {
    expect(matchesPlannedFilter('2020-01-01', 'all', '', bounds)).toBe(true)
    expect(matchesPlannedFilter(null, 'all', '', bounds)).toBe(true)
  })

  it("'overdue' = strictly before today, and never a dateless row", () => {
    expect(matchesPlannedFilter('2026-07-21', 'overdue', '', bounds)).toBe(true)
    expect(matchesPlannedFilter('2026-07-22', 'overdue', '', bounds)).toBe(false) // today is not overdue
    expect(matchesPlannedFilter(null, 'overdue', '', bounds)).toBe(false)
    expect(matchesPlannedFilter(undefined, 'overdue', '', bounds)).toBe(false)
  })

  it("'today' matches only the exact local day", () => {
    expect(matchesPlannedFilter('2026-07-22', 'today', '', bounds)).toBe(true)
    expect(matchesPlannedFilter('2026-07-23', 'today', '', bounds)).toBe(false)
    expect(matchesPlannedFilter(null, 'today', '', bounds)).toBe(false)
  })

  it("'week' is inclusive Monday..Sunday", () => {
    expect(matchesPlannedFilter('2026-07-20', 'week', '', bounds)).toBe(true)
    expect(matchesPlannedFilter('2026-07-26', 'week', '', bounds)).toBe(true)
    expect(matchesPlannedFilter('2026-07-19', 'week', '', bounds)).toBe(false)
    expect(matchesPlannedFilter('2026-07-27', 'week', '', bounds)).toBe(false)
    expect(matchesPlannedFilter(null, 'week', '', bounds)).toBe(false)
  })

  it("'has' / 'none' split on presence (empty string counts as no date)", () => {
    expect(matchesPlannedFilter('2026-07-22', 'has', '', bounds)).toBe(true)
    expect(matchesPlannedFilter(null, 'has', '', bounds)).toBe(false)
    expect(matchesPlannedFilter('', 'has', '', bounds)).toBe(false)
    expect(matchesPlannedFilter(null, 'none', '', bounds)).toBe(true)
    expect(matchesPlannedFilter('2026-07-22', 'none', '', bounds)).toBe(false)
  })

  it('an exact date overrides the bucket filter entirely', () => {
    expect(matchesPlannedFilter('2026-08-03', 'overdue', '2026-08-03', bounds)).toBe(true) // bucket says no, exact says yes
    expect(matchesPlannedFilter('2026-07-21', 'overdue', '2026-08-03', bounds)).toBe(false) // overdue but not the picked day
    expect(matchesPlannedFilter(null, 'all', '2026-08-03', bounds)).toBe(false)
  })
})

describe('formatPlannedDate', () => {
  it('renders "YYYY-MM-DD" as MM/DD/YY via pure string slicing', () => {
    expect(formatPlannedDate('2026-08-03')).toBe('08/03/26')
  })
  it('passes malformed values through verbatim and nulls to null', () => {
    expect(formatPlannedDate('soon')).toBe('soon')
    expect(formatPlannedDate(null)).toBeNull()
    expect(formatPlannedDate(undefined)).toBeNull()
    expect(formatPlannedDate('')).toBeNull()
  })
})
