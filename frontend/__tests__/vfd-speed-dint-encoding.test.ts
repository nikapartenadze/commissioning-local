import { describe, it, expect } from 'vitest'
import { encodeScalarWrite, scalarReadBackMatches } from '@/lib/plc/plc-client'

/**
 * Regression guard for the VFD speed-setpoint overflow.
 *
 * HMI.Speed_At_30rev is a DINT on the controller. The tool used to write it as a
 * REAL — laying down the float32 BIT-PATTERN — which the controller then read as
 * an integer (~1.1e9), over-driving belts. These tests pin the encoding so a
 * DINT can never again be written as float bits, and pin the read-back verify
 * that catches a type mismatch before a garbage value is trusted on a live drive.
 */

// 30.0 as a float32 bit-pattern, read back as a little-endian int32. This is the
// exact garbage a DINT tag would store if a REAL value were written into it.
const REAL_30_BITS = 1106247680

describe('encodeScalarWrite — DINT writes the number, REAL writes float bits', () => {
  it('DINT writes the NUMERIC integer (the fix), not float bits', () => {
    expect(encodeScalarWrite('DINT', 30)).toEqual({ kind: 'int32', raw: 30 })
  })

  it('DINT rounds a fractional RVS to the nearest whole number', () => {
    expect(encodeScalarWrite('DINT', 25.3).raw).toBe(25)
    expect(encodeScalarWrite('DINT', 25.6).raw).toBe(26)
  })

  it('REAL still writes the float32 bit-pattern (correct for a REAL tag)', () => {
    expect(encodeScalarWrite('REAL', 30)).toEqual({ kind: 'int32', raw: REAL_30_BITS })
  })

  it('the overflow: REAL-encoded 30 is the ~1.1e9 garbage a DINT would have stored', () => {
    // This is precisely why the bug damaged hardware — and why DINT must differ.
    expect(encodeScalarWrite('REAL', 30).raw).not.toBe(30)
    expect(encodeScalarWrite('REAL', 30).raw).toBeGreaterThan(1e9)
    expect(encodeScalarWrite('DINT', 30).raw).toBe(30)
  })

  it('INT writes a rounded 16-bit value; BOOL writes 0/1', () => {
    expect(encodeScalarWrite('INT', 12.7)).toEqual({ kind: 'int16', raw: 13 })
    expect(encodeScalarWrite('BOOL', 1)).toEqual({ kind: 'int8', raw: 1 })
    expect(encodeScalarWrite('BOOL', 0)).toEqual({ kind: 'int8', raw: 0 })
  })
})

describe('scalarReadBackMatches — write verify catches a type mismatch', () => {
  it('DINT matches when the controller stored the integer we sent', () => {
    expect(scalarReadBackMatches('DINT', 30, 30)).toBe(true)
    expect(scalarReadBackMatches('DINT', 25.3, 25)).toBe(true) // rounded
  })

  it('DINT mismatch when the tag reads back the REAL-bit-pattern garbage', () => {
    // The exact failure mode: value NOT trusted, write reported as failed.
    expect(scalarReadBackMatches('DINT', 30, REAL_30_BITS)).toBe(false)
  })

  it('REAL matches within float tolerance, fails on a wild value', () => {
    expect(scalarReadBackMatches('REAL', 30, 30.0005)).toBe(true)
    expect(scalarReadBackMatches('REAL', 30, REAL_30_BITS)).toBe(false)
  })
})
