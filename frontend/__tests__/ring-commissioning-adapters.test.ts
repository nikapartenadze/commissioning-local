import { describe, it, expect } from 'vitest'
import { selectVendor, decodeRingState } from '@/lib/plc/network/ring-commissioning/snmp/adapters'
import { OID } from '@/lib/plc/network/ring-commissioning/snmp/mibs'

describe('selectVendor', () => {
  it('classifies by name hint, defaulting to generic', () => {
    expect(selectVendor('MTN6_SW1', 'moxa')).toBe('moxa')
    expect(selectVendor('UL17_8_DPM1')).toBe('hirschmann') // DPM = Hirschmann Octopus
    expect(selectVendor('SOME_SWITCH')).toBe('generic')
  })
})

describe('decodeRingState', () => {
  it('MRP closed(2) => closed ring', () => {
    const rows = [{ oid: `${OID.hmMrpMRMRealRingState}.0`, value: '2' }]
    const s = decodeRingState('hirschmann', rows)
    expect(s.source).toBe('mrp')
    expect(s.closed).toBe(true)
  })
  it('MRP open(1) => open ring', () => {
    const rows = [{ oid: `${OID.hmMrpMRMRealRingState}.0`, value: '1' }]
    expect(decodeRingState('hirschmann', rows).closed).toBe(false)
  })
  it('Moxa with no configured OID => reported but not false-green', () => {
    const s = decodeRingState('moxa', [])
    expect(s.source).toBe('moxa')
    expect(s.closed).toBe(false)
  })
  it('generic => source none, never green', () => {
    expect(decodeRingState('generic', []).closed).toBe(false)
  })
})
