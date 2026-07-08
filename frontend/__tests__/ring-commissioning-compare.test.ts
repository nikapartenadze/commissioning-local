import { describe, it, expect } from 'vitest'
import { compareTopology } from '@/lib/plc/network/ring-commissioning/compare'
import type { RingTopology } from '@/lib/plc/network/ring-commissioning/types'

function base(): RingTopology {
  return {
    links: [{ localDevice: 'DPM1', localPort: 3, remoteDevice: 'DPM2', remotePort: 1 }],
    leaves: [{ device: 'UL17_8_FIOM1', switchName: 'DPM1', port: 7 }],
    terminations: [{ device: 'DPM1', port: 3, linkUp: true, speedMbps: 1000, fullDuplex: true, mediaErrors: false }],
    ring: { closed: true, source: 'dlr', reason: 'Ring closed (Normal)' },
  }
}

describe('compareTopology', () => {
  it('all match + ring closed + clean terminations => healthy', () => {
    const v = compareTopology(base(), base())
    expect(v.healthy).toBe(true)
    expect(v.links.every(l => l.kind === 'match')).toBe(true)
  })

  it('right neighbor on wrong port => wrong-port, not healthy (the MTN6 case)', () => {
    const actual = base()
    actual.links[0].remotePort = 2 // drawn as 1
    const v = compareTopology(base(), actual)
    expect(v.healthy).toBe(false)
    expect(v.links.find(l => l.kind === 'wrong-port')).toBeTruthy()
  })

  it('different neighbor => wrong-neighbor', () => {
    const actual = base()
    actual.links[0].remoteDevice = 'DPM3'
    const v = compareTopology(base(), actual)
    expect(v.links.find(l => l.kind === 'wrong-neighbor')).toBeTruthy()
  })

  it('baseline link absent in actual => missing', () => {
    const actual = base()
    actual.links = []
    const v = compareTopology(base(), actual)
    expect(v.links.find(l => l.kind === 'missing')).toBeTruthy()
  })

  it('actual link not in baseline => unexpected', () => {
    const actual = base()
    actual.links.push({ localDevice: 'DPM2', localPort: 5, remoteDevice: 'DPM9', remotePort: 1 })
    const v = compareTopology(base(), actual)
    expect(v.links.find(l => l.kind === 'unexpected')).toBeTruthy()
  })

  it('media errors on a port => termination-fault, not healthy', () => {
    const actual = base()
    actual.terminations[0].mediaErrors = true
    const v = compareTopology(base(), actual)
    expect(v.healthy).toBe(false)
    expect(v.terminationFaults.length).toBe(1)
  })

  it('ring open => not healthy and ringClosed false', () => {
    const actual = base()
    actual.ring = { closed: false, source: 'dlr', reason: 'Ring Fault', breakBetween: ['DPM1', 'DPM2'] }
    const v = compareTopology(base(), actual)
    expect(v.healthy).toBe(false)
    expect(v.ringClosed).toBe(false)
  })
})
