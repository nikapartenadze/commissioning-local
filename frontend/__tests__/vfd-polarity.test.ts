import { describe, it, expect } from 'vitest'
import {
  parsePolarity,
  polarityFlagWrites,
  deviceFlagWrites,
} from '@/lib/vfd-polarity'

describe('parsePolarity', () => {
  it('reads Normal / Inverter out of a stamped cell, case-insensitively', () => {
    expect(parsePolarity('ASH 9/5 · Normal')).toBe('Normal')
    expect(parsePolarity('ASH 9/5 · Inverter')).toBe('Inverter')
    expect(parsePolarity('jp 12/1 · inverter')).toBe('Inverter')
  })
  it('returns null for empty / unrecognized / legacy values', () => {
    expect(parsePolarity(null)).toBeNull()
    expect(parsePolarity(undefined)).toBeNull()
    expect(parsePolarity('')).toBeNull()
    expect(parsePolarity('ASH 9/5')).toBeNull() // direction stamped, polarity not
  })
})

describe('polarityFlagWrites', () => {
  it('Normal → Normal_Polarity=1, Reverse_Polarity=0 (both bits, per AOI latch)', () => {
    expect(polarityFlagWrites('x · Normal')).toEqual([
      { field: 'Normal_Polarity', value: 1 },
      { field: 'Reverse_Polarity', value: 0 },
    ])
  })
  it('Inverter → Normal_Polarity=0, Reverse_Polarity=1', () => {
    expect(polarityFlagWrites('x · Inverter')).toEqual([
      { field: 'Normal_Polarity', value: 0 },
      { field: 'Reverse_Polarity', value: 1 },
    ])
  })
  it('no recorded polarity → no writes (leaves the drive routing untouched)', () => {
    expect(polarityFlagWrites(null)).toEqual([])
    expect(polarityFlagWrites('ASH 9/5')).toEqual([])
  })
})

describe('deviceFlagWrites', () => {
  it('always asserts the three validation flags = 1', () => {
    const writes = deviceFlagWrites(null)
    expect(writes).toEqual([
      { field: 'Valid_Map', value: 1 },
      { field: 'Valid_HP', value: 1 },
      { field: 'Valid_Direction', value: 1 },
    ])
  })
  it('adds the polarity pair when recorded (Inverter)', () => {
    const writes = deviceFlagWrites('ASH 9/5 · Inverter')
    expect(writes).toEqual([
      { field: 'Valid_Map', value: 1 },
      { field: 'Valid_HP', value: 1 },
      { field: 'Valid_Direction', value: 1 },
      { field: 'Normal_Polarity', value: 0 },
      { field: 'Reverse_Polarity', value: 1 },
    ])
  })
})
