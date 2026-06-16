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
  { vendorId: 1, productCode: 166, modelName: '1756-L85E', minRevMajor: 33, minRevMinor: 11 },
  { vendorId: 1, productCode: 200, modelName: '1756-EN4TR', minRevMajor: 5, minRevMinor: 1 },
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
  it('matches on (vendorId, productCode)', () => {
    expect(findBaseline(baselines, 1, 166)?.modelName).toBe('1756-L85E')
    expect(findBaseline(baselines, 1, 200)?.modelName).toBe('1756-EN4TR')
  })
  it('returns undefined for an unknown device', () => {
    expect(findBaseline(baselines, 1, 999)).toBeUndefined()
    expect(findBaseline(baselines, 9, 166)).toBeUndefined()
  })
  it('matches by productCode alone when vendorId is null (diagnostics-sourced)', () => {
    expect(findBaseline(baselines, null, 166)?.modelName).toBe('1756-L85E')
    expect(findBaseline(baselines, null, 999)).toBeUndefined()
  })
})

describe('evaluateCompliance', () => {
  it('is unreachable when there is no identity reading', () => {
    expect(evaluateCompliance(null, baselines[0])).toBe('unreachable')
  })
  it('is no_baseline when the device has no matching baseline entry', () => {
    expect(evaluateCompliance(ident(1, 999, 1, 0), undefined)).toBe('no_baseline')
  })
  it('is compliant when live revision equals the minimum', () => {
    expect(evaluateCompliance(ident(1, 166, 33, 11), baselines[0])).toBe('compliant')
  })
  it('is compliant when live revision is newer than the minimum', () => {
    expect(evaluateCompliance(ident(1, 166, 34, 0), baselines[0])).toBe('compliant')
    expect(evaluateCompliance(ident(1, 166, 33, 12), baselines[0])).toBe('compliant')
  })
  it('is non_compliant when live revision is older than the minimum', () => {
    expect(evaluateCompliance(ident(1, 166, 32, 50), baselines[0])).toBe('non_compliant')
    expect(evaluateCompliance(ident(1, 166, 33, 10), baselines[0])).toBe('non_compliant')
  })
})
