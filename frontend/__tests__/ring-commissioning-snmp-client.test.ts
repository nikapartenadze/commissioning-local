import { describe, it, expect } from 'vitest'
import { snmpWalk, loadNetSnmp } from '@/lib/plc/network/ring-commissioning/snmp/client'

describe('loadNetSnmp', () => {
  it('reports whether the optional dependency is present (never throws)', () => {
    const r = loadNetSnmp()
    expect(typeof r.ok).toBe('boolean')
  })
})

describe('snmpWalk', () => {
  it('returns available:false with a reason for an unreachable host (never throws)', async () => {
    const res = await snmpWalk('192.0.2.1', '1.3.6.1.2.1.1.1', { version: 'v2c', community: 'public', timeoutMs: 300, retries: 0 })
    expect(res.available).toBe(false)
    if (!res.available) expect(typeof res.reason).toBe('string')
  }, 8000)
})
