import { describe, it, expect } from 'vitest'
import { assembleTopology, captureRing } from '@/lib/plc/network/ring-commissioning/capture'
import type { SnmpReadResult } from '@/lib/plc/network/ring-commissioning/snmp/client'

describe('assembleTopology', () => {
  it('dedupes reverse-direction LLDP links and carries ring + terminations', () => {
    const t = assembleTopology({
      links: [
        { localDevice: 'DPM1', localPort: 3, remoteDevice: 'DPM2', remotePort: 1 },
        { localDevice: 'DPM2', localPort: 1, remoteDevice: 'DPM1', remotePort: 3 }, // reverse dup
      ],
      leaves: [{ device: 'FIOM1', switchName: 'DPM1', port: 7 }],
      terminations: [{ device: 'DPM1', port: 3, linkUp: true, speedMbps: 1000, fullDuplex: true, mediaErrors: false }],
      ring: { closed: true, source: 'dlr', reason: 'Ring closed (Normal)' },
    })
    expect(t.links.length).toBe(1)
    expect(t.leaves.length).toBe(1)
    expect(t.ring.closed).toBe(true)
  })
})

describe('captureRing', () => {
  it('returns ok:false when nothing responds and there is no DLR', async () => {
    const deadWalk = async (): Promise<SnmpReadResult> => ({ available: false, reason: 'unreachable' })
    const res = await captureRing([{ name: 'DPM1', ip: '10.0.0.1' }], { version: 'v2c' }, {
      resolveChassis: (c) => c, resolveMac: () => null, portIfIndex: () => new Map(),
      dlrRing: null, terminations: () => [], walk: deadWalk,
    })
    expect(res.ok).toBe(false)
  })

  it('captures links from injected SNMP + carries the DLR ring verdict', async () => {
    const fakeWalk = async (_host: string, oid: string): Promise<SnmpReadResult> => {
      if (oid.startsWith('1.0.8802.1.1.2.1.4.1.1.5')) return { available: true, rows: [{ oid: `${oid}.0.3.1`, value: 'DPM2' }] }
      if (oid.startsWith('1.0.8802.1.1.2.1.4.1.1.7')) return { available: true, rows: [{ oid: `${oid}.0.3.1`, value: '1' }] }
      return { available: true, rows: [] }
    }
    const res = await captureRing([{ name: 'DPM1', ip: '10.0.0.1' }], { version: 'v2c' }, {
      resolveChassis: (c) => c, resolveMac: () => null, portIfIndex: () => new Map(),
      dlrRing: { closed: true, source: 'dlr', reason: 'Ring closed (Normal)' }, terminations: () => [], walk: fakeWalk,
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.topology.links).toEqual([{ localDevice: 'DPM1', localPort: 3, remoteDevice: 'DPM2', remotePort: 1 }])
      expect(res.topology.ring.source).toBe('dlr')
    }
  })
})
