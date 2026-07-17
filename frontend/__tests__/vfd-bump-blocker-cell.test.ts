import { describe, it, expect } from 'vitest'
import { formatBumpBlockerCell, parseBumpBlockerCell, resolveDeviceBlocked } from '@/lib/vfd-bump-blocker'

describe('resolveDeviceBlocked — local cell vs cloud mirror precedence', () => {
  const cell = { party: 'Mechanical', description: 'belt slipping' }
  const mirror = { party: 'Mechanical', description: 'belt not moving' }

  it('local cell wins when present (a blocker raised on THIS box)', () => {
    expect(resolveDeviceBlocked(cell, mirror, false)).toEqual(cell)
    expect(resolveDeviceBlocked(cell, null, true)).toEqual(cell)
  })

  it('empty cell + no pending + mirror → blocked from the mirror (another box)', () => {
    expect(resolveDeviceBlocked(null, mirror, false)).toEqual({ party: 'Mechanical', description: 'belt not moving' })
  })

  it('BUG C FIX: empty cell + in-flight local op + stale mirror → NOT blocked', () => {
    // Tech just CLEARED the blocker on this box: cell is blank (→ null) and a
    // 'clear' op is queued in DeviceBlockerPendingSyncs, but the mirror still
    // holds the pre-clear row (only a pull prunes it). The just-cleared box must
    // NOT show blocked — local intent wins over the stale mirror.
    expect(resolveDeviceBlocked(null, mirror, true)).toBeNull()
  })

  it('empty cell + no pending + no mirror → not blocked', () => {
    expect(resolveDeviceBlocked(null, null, false)).toBeNull()
    expect(resolveDeviceBlocked(null, undefined, false)).toBeNull()
  })

  it('tolerates a mirror row with null party/description (treated as not blocked)', () => {
    expect(resolveDeviceBlocked(null, { party: null, description: null }, false)).toBeNull()
  })
})

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
