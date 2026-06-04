/**
 * Test: per-flag validation writer mapping (Kevin taskboard #2170).
 *
 * The validation writer no longer waits for "Check Direction" before asserting
 * ANY flag. Instead it asserts each Valid_* flag the moment its wizard step is
 * complete, so a VFD whose identity is established (but whose bump test later
 * fails) still gets Valid_Map — which the AOI uses to unlock the F0/F1/F2
 * keypad controls so mech can troubleshoot. See the file header of
 * vfd-validation-writer.ts and the design spec for the WHY.
 *
 * `flagsForDevice(row)` is the pure row→writes mapping. It must:
 *   - emit Valid_Map=1 iff identity is stamped,
 *   - emit Valid_HP=1 iff BOTH HP cells are filled,
 *   - emit Valid_Direction (+ the polarity pair) iff direction is stamped,
 *   - ASSERT-ONLY: never emit a 0 for an un-earned flag,
 *   - emit polarity bits ONLY when direction is stamped.
 *
 * The full-progress case is compared against deviceFlagWrites()'s ACTUAL
 * output (imported, not hardcoded) so it can never drift from the polarity
 * helper.
 */
import { describe, it, expect } from 'vitest'
import { flagsForDevice, type ValidationRow } from '@/lib/vfd-validation-writer'
import { deviceFlagWrites } from '@/lib/vfd-polarity'

function row(over: Partial<ValidationRow>): ValidationRow {
  return {
    deviceName: 'UL9_9_VFD1',
    sheetName: 'MCM09 VFD',
    hasIdentity: 0,
    hasMotorHp: 0,
    hasVfdHp: 0,
    hasDirection: 0,
    polarityRaw: null,
    ...over,
  }
}

describe('flagsForDevice', () => {
  it('identity only → just Valid_Map (no HP, no Direction, no polarity)', () => {
    const writes = flagsForDevice(row({ hasIdentity: 1 }))
    expect(writes).toEqual([{ field: 'Valid_Map', value: 1 }])
  })

  it('identity + both HP cells → Valid_Map + Valid_HP', () => {
    const writes = flagsForDevice(row({ hasIdentity: 1, hasMotorHp: 1, hasVfdHp: 1 }))
    expect(writes).toEqual([
      { field: 'Valid_Map', value: 1 },
      { field: 'Valid_HP', value: 1 },
    ])
  })

  it('HP with only one cell filled → no Valid_HP', () => {
    expect(flagsForDevice(row({ hasIdentity: 1, hasMotorHp: 1, hasVfdHp: 0 }))).toEqual([
      { field: 'Valid_Map', value: 1 },
    ])
    expect(flagsForDevice(row({ hasIdentity: 1, hasMotorHp: 0, hasVfdHp: 1 }))).toEqual([
      { field: 'Valid_Map', value: 1 },
    ])
  })

  it('HP filled but no identity → Valid_HP only (assert-only, no Valid_Map)', () => {
    // Order-independent set comparison: identity not earned, so no Valid_Map.
    const writes = flagsForDevice(row({ hasMotorHp: 1, hasVfdHp: 1 }))
    expect(writes).toEqual([{ field: 'Valid_HP', value: 1 }])
  })

  it('full progress → Valid_Map + Valid_HP + Valid_Direction + polarity pair', () => {
    const polarityRaw = 'AI 5/29 · Inverter'
    const writes = flagsForDevice(
      row({ hasIdentity: 1, hasMotorHp: 1, hasVfdHp: 1, hasDirection: 1, polarityRaw }),
    )
    // Direction-and-polarity portion must match deviceFlagWrites EXACTLY — its
    // output is the single source of truth for Valid_Direction + polarity bits.
    // deviceFlagWrites emits [Valid_Map, Valid_HP, Valid_Direction, ...polarity];
    // here Valid_Map/Valid_HP are earned independently, so the union is the same set.
    const expected = deviceFlagWrites(polarityRaw)
    expect(writes).toHaveLength(expected.length)
    for (const fw of expected) {
      expect(writes).toContainEqual(fw)
    }
    // And explicitly: the direction + polarity pair are present.
    expect(writes).toContainEqual({ field: 'Valid_Direction', value: 1 })
    expect(writes).toContainEqual({ field: 'Normal_Polarity', value: 0 })
    expect(writes).toContainEqual({ field: 'Reverse_Polarity', value: 1 })
  })

  it('direction stamped but no polarity recorded → Valid_Direction, NO polarity bits', () => {
    const writes = flagsForDevice(row({ hasIdentity: 1, hasDirection: 1, polarityRaw: null }))
    expect(writes).toContainEqual({ field: 'Valid_Map', value: 1 })
    expect(writes).toContainEqual({ field: 'Valid_Direction', value: 1 })
    expect(writes.some((w) => w.field === 'Normal_Polarity')).toBe(false)
    expect(writes.some((w) => w.field === 'Reverse_Polarity')).toBe(false)
  })

  it('polarity recorded but direction NOT stamped → no polarity bits, no Valid_Direction', () => {
    const writes = flagsForDevice(row({ hasIdentity: 1, hasDirection: 0, polarityRaw: 'AI 5/29 · Normal' }))
    expect(writes).toEqual([{ field: 'Valid_Map', value: 1 }])
  })

  it('no progress at all → empty (assert-only, never writes 0s)', () => {
    expect(flagsForDevice(row({}))).toEqual([])
    // Crucially: never a single 0-valued write anywhere.
    const all = flagsForDevice(row({ hasIdentity: 1, hasMotorHp: 1, hasVfdHp: 1, hasDirection: 1, polarityRaw: 'x · Normal' }))
    expect(all.filter((w) => w.field.startsWith('Valid_')).every((w) => w.value === 1)).toBe(true)
  })
})
