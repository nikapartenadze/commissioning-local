import { describe, it, expect } from 'vitest'
import {
  compareRevision,
  findBaseline,
  evaluateCompliance,
  type FirmwareBaseline,
} from '@/lib/plc/identity/compliance'
import type { DeviceIdentity } from '@/lib/plc/identity/identity-parse'

const ident = (vendorId: number, productCode: number, revMajor: number, revMinor: number): DeviceIdentity => ({
  vendorId, deviceType: 14, productCode, revMajor, revMinor,
  status: 0, serial: 0, productName: 'TEST',
})

const baselines: FirmwareBaseline[] = [
  { vendorId: 1, productCode: 166, modelName: '1756-L85E', minRevMajor: 33, minRevMinor: 11, subsystemId: null },
  { vendorId: 1, productCode: 200, modelName: '1756-EN4TR', minRevMajor: 5, minRevMinor: 1, subsystemId: null },
]

describe('compareRevision', () => {
  it('orders by major first, then minor', () => {
    expect(compareRevision(33, 11, 33, 11)).toBe(0)
    expect(compareRevision(34, 0, 33, 11)).toBeGreaterThan(0)  // newer major
    expect(compareRevision(33, 12, 33, 11)).toBeGreaterThan(0) // newer minor
    expect(compareRevision(32, 99, 33, 11)).toBeLessThan(0)    // older major beats higher minor
    expect(compareRevision(33, 10, 33, 11)).toBeLessThan(0)    // older minor
  })
})

describe('findBaseline', () => {
  it('matches on (vendorId, productCode) at fleet scope and flags fleetDefault', () => {
    const hit166 = findBaseline(baselines, 1, 166, null)
    expect(hit166?.baseline.modelName).toBe('1756-L85E')
    expect(hit166?.fleetDefault).toBe(true)
    const hit200 = findBaseline(baselines, 1, 200, null)
    expect(hit200?.baseline.modelName).toBe('1756-EN4TR')
    expect(hit200?.fleetDefault).toBe(true)
  })
  it('returns undefined for an unknown device', () => {
    expect(findBaseline(baselines, 1, 999, null)).toBeUndefined()
    expect(findBaseline(baselines, 9, 166, null)).toBeUndefined()
  })
  it('matches by productCode alone when vendorId is null (diagnostics-sourced)', () => {
    expect(findBaseline(baselines, null, 166, null)?.baseline.modelName).toBe('1756-L85E')
    expect(findBaseline(baselines, null, 999, null)).toBeUndefined()
  })
  it('prefers the row scoped to this subsystem over the fleet-wide row', () => {
    const rows: FirmwareBaseline[] = [
      { vendorId: 1, productCode: 2, minRevMajor: 2, minRevMinor: 1, subsystemId: null },
      { vendorId: 1, productCode: 2, minRevMajor: 2, minRevMinor: 6, subsystemId: 47 },
    ]
    const hit = findBaseline(rows, 1, 2, 47)
    expect(hit?.baseline.minRevMinor).toBe(6)
    expect(hit?.fleetDefault).toBe(false)
  })
  it('falls back to the fleet-wide row and flags it when this subsystem has no row', () => {
    const rows: FirmwareBaseline[] = [
      { vendorId: 1, productCode: 2, minRevMajor: 2, minRevMinor: 1, subsystemId: null },
      { vendorId: 1, productCode: 2, minRevMajor: 2, minRevMinor: 6, subsystemId: 99 },
    ]
    const hit = findBaseline(rows, 1, 2, 47)
    expect(hit?.baseline.minRevMinor).toBe(1)
    expect(hit?.fleetDefault).toBe(true)
  })
  it('returns undefined when neither the scoped nor a fleet-wide row exists', () => {
    const rows: FirmwareBaseline[] = [
      { vendorId: 1, productCode: 2, minRevMajor: 2, minRevMinor: 1, subsystemId: 99 },
    ]
    expect(findBaseline(rows, 1, 2, 47)).toBeUndefined()
  })
})

describe('evaluateCompliance (exact match)', () => {
  it('is unreachable when there is no identity reading', () => {
    expect(evaluateCompliance(null, baselines[0])).toBe('unreachable')
  })
  it('is no_baseline when the device has no matching baseline entry', () => {
    expect(evaluateCompliance(ident(1, 999, 1, 0), undefined)).toBe('no_baseline')
  })
  it('is compliant when live revision equals the approved revision exactly', () => {
    expect(evaluateCompliance(ident(1, 166, 33, 11), baselines[0])).toBe('compliant')
  })
  it('is differs (not compliant) when live revision is newer than approved', () => {
    expect(evaluateCompliance(ident(1, 166, 34, 0), baselines[0])).toBe('differs')
    expect(evaluateCompliance(ident(1, 166, 33, 12), baselines[0])).toBe('differs')
  })
  it('is non_compliant when live revision is older than approved', () => {
    expect(evaluateCompliance(ident(1, 166, 32, 50), baselines[0])).toBe('non_compliant')
    expect(evaluateCompliance(ident(1, 166, 33, 10), baselines[0])).toBe('non_compliant')
  })
  it('is non_compliant when live revision is a different (non-newer) revision than approved', () => {
    // Same major, lower minor than approved 33.11.
    expect(evaluateCompliance(ident(1, 166, 33, 0), baselines[0])).toBe('non_compliant')
  })

  it('36.1 and 36.11 are different revisions', () => {
    const approved361 = { vendorId: 1, productCode: 2, minRevMajor: 36, minRevMinor: 1, subsystemId: null }
    const approved3611 = { vendorId: 1, productCode: 2, minRevMajor: 36, minRevMinor: 11, subsystemId: null }
    expect(evaluateCompliance(ident(1, 2, 36, 11), approved361)).toBe('differs')
    expect(evaluateCompliance(ident(1, 2, 36, 1), approved3611)).toBe('non_compliant')
  })

  // These pairs discriminate against a parseFloat-based compareRevision:
  // - minors 1 vs 10: as floats "36.1" and "36.10" both parse to 36.1, collapsing to equal
  // - minors 2 vs 11: as floats "36.2" vs "36.11", 0.2 > 0.11 reverses the integer order
  it('minors 1 vs 10 collapse to equal as floats but differ as integers', () => {
    const approved1 = { vendorId: 1, productCode: 2, minRevMajor: 36, minRevMinor: 1, subsystemId: null }
    const approved10 = { vendorId: 1, productCode: 2, minRevMajor: 36, minRevMinor: 10, subsystemId: null }
    expect(evaluateCompliance(ident(1, 2, 36, 10), approved1)).toBe('differs')
    expect(evaluateCompliance(ident(1, 2, 36, 1), approved10)).toBe('non_compliant')
  })
  it('minors 2 vs 11 reverse order as floats but not as integers', () => {
    const approved11 = { vendorId: 1, productCode: 2, minRevMajor: 36, minRevMinor: 11, subsystemId: null }
    const approved2 = { vendorId: 1, productCode: 2, minRevMajor: 36, minRevMinor: 2, subsystemId: null }
    expect(evaluateCompliance(ident(1, 2, 36, 2), approved11)).toBe('non_compliant')
    expect(evaluateCompliance(ident(1, 2, 36, 11), approved2)).toBe('differs')
  })

  it('judges two MCMs independently for the same model', () => {
    const rows: FirmwareBaseline[] = [
      { vendorId: 1, productCode: 2, minRevMajor: 2, minRevMinor: 1, subsystemId: 40 },
      { vendorId: 1, productCode: 2, minRevMajor: 2, minRevMinor: 6, subsystemId: 41 },
    ]
    const live = ident(1, 2, 2, 1)
    expect(evaluateCompliance(live, findBaseline(rows, null, 2, 40)?.baseline)).toBe('compliant')
    expect(evaluateCompliance(live, findBaseline(rows, null, 2, 41)?.baseline)).toBe('non_compliant')
  })
})
