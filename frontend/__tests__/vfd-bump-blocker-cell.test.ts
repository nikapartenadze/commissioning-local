import { describe, it, expect } from 'vitest'
import { formatBumpBlockerCell, parseBumpBlockerCell } from '@/lib/vfd-bump-blocker'

describe('vfd-bump-blocker L2 cell helpers', () => {
  it('round-trips a simple blocker', () => {
    const cell = formatBumpBlockerCell('ASH 9/5', 'Mechanical', 'VFD turns on, drive shaft doesn\'t move')
    expect(cell).toBe('ASH 9/5 · Mechanical · VFD turns on, drive shaft doesn\'t move')
    const parsed = parseBumpBlockerCell(cell)
    expect(parsed).toEqual({ party: 'Mechanical', description: 'VFD turns on, drive shaft doesn\'t move' })
  })

  it('preserves a description that itself contains the separator', () => {
    const description = 'Other: belt slipping · then stalls · weird'
    const cell = formatBumpBlockerCell('JD 6/4', 'Electrical', description)
    const parsed = parseBumpBlockerCell(cell)
    expect(parsed).toEqual({ party: 'Electrical', description })
  })

  it('returns null for empty string', () => {
    expect(parseBumpBlockerCell('')).toBeNull()
  })

  it('returns null for null/undefined', () => {
    expect(parseBumpBlockerCell(null)).toBeNull()
    expect(parseBumpBlockerCell(undefined)).toBeNull()
  })

  it('returns null for whitespace-only', () => {
    expect(parseBumpBlockerCell('   ')).toBeNull()
  })

  it('returns null for single-segment garbage (no party/description)', () => {
    expect(parseBumpBlockerCell('ASH 9/5')).toBeNull()
  })

  it('returns null when the party segment is present but description is empty', () => {
    expect(parseBumpBlockerCell('ASH 9/5 · Mechanical')).toBeNull()
    expect(parseBumpBlockerCell('ASH 9/5 · Mechanical · ')).toBeNull()
  })
})
