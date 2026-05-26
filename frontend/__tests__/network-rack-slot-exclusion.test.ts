import { describe, it, expect } from 'vitest'
import { EXCLUDED_RACK_SLOTS, isExcludedRackSlot } from '@/lib/plc/network/types'

describe('isExcludedRackSlot', () => {
  it('excludes SLOT5/6/7 device + tag names', () => {
    expect(isExcludedRackSlot('SLOT5_EN4TR_NetworkNode')).toBe(true)
    expect(isExcludedRackSlot('SLOT6_EN2TR')).toBe(true)
    expect(isExcludedRackSlot('SLOT7')).toBe(true)
  })

  // The exact device + tag names this controller (subsystem 38) actually
  // discovered — captured from a live @tags browse. These are the names the
  // field asked us to drop. Tag form (…_NN) and stripped device form both match.
  it('excludes the real SLOT5/6/7 names seen on the live controller', () => {
    expect(isExcludedRackSlot('SLOT5_IB16_NN')).toBe(true)
    expect(isExcludedRackSlot('SLOT5_IB16')).toBe(true)
    expect(isExcludedRackSlot('SLOT6_OB16E_NN')).toBe(true)
    expect(isExcludedRackSlot('SLOT6_OB16E')).toBe(true)
    expect(isExcludedRackSlot('SLOT7_IB16S_NN')).toBe(true)
    expect(isExcludedRackSlot('SLOT7_IB16S')).toBe(true)
  })

  it('keeps the real neighbouring devices that must NOT be dropped', () => {
    // From the same live discovery — these stay in the readings.
    expect(isExcludedRackSlot('SLOT2_EN4TR')).toBe(false)
    expect(isExcludedRackSlot('PDP01_FIOM1')).toBe(false)
    expect(isExcludedRackSlot('UL29_8_DPM1')).toBe(false)
    expect(isExcludedRackSlot('UL27_10_VFD')).toBe(false)
  })

  it('matches a SLOT token after an underscore, not just at the start', () => {
    expect(isExcludedRackSlot('MCM04_SLOT5_NN')).toBe(true)
    expect(isExcludedRackSlot('EN4TR_SLOT6')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isExcludedRackSlot('slot7_en4tr')).toBe(true)
  })

  it('keeps other rack slots', () => {
    expect(isExcludedRackSlot('SLOT2_EN4TR_NetworkNode')).toBe(false)
    expect(isExcludedRackSlot('SLOT4_DPM1_NN')).toBe(false)
  })

  it('does not over-match longer slot numbers that merely start with 5/6/7', () => {
    expect(isExcludedRackSlot('SLOT15_X')).toBe(false)
    expect(isExcludedRackSlot('SLOT57_X')).toBe(false)
    expect(isExcludedRackSlot('SLOT70_X')).toBe(false)
  })

  it('ignores names with no SLOT token', () => {
    expect(isExcludedRackSlot('UL17_8_DPM1_NN.Data')).toBe(false)
    expect(isExcludedRackSlot('VFD_UL29_19_NetworkNode')).toBe(false)
    expect(isExcludedRackSlot('')).toBe(false)
  })

  it('exposes the excluded slot numbers as a constant', () => {
    expect([...EXCLUDED_RACK_SLOTS]).toEqual([5, 6, 7])
  })
})
