/**
 * Test: the app-side remote-cache correctly patches its read model from the
 * broadcast stream. These patches keep server-side route logic (test gating,
 * status reads) fresh between gateway /state polls in the split deployment.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyBroadcastToCache,
  getCachedMcm,
  getCachedTagsForMcm,
  getCachedState,
} from '@/lib/plc/remote-cache'

// Seed the cache's global singleton directly (same shape the poller writes).
function seed() {
  const g = globalThis as any
  g.__plcRemoteCache = {
    state: {
      mcms: [
        { subsystemId: '41', name: 'MCM01', ip: '10.0.0.1', path: '1,0', connected: false, status: 'disconnected', tagCount: 2 },
      ],
      aggregate: { anyConnected: false, connectedCount: 0, totalCount: 1, totalTagCount: 2 },
      tags: [
        { id: 100, name: 'Tag_A', state: 'FALSE', subsystemId: '41' },
        { id: 101, name: 'Tag_B', state: 'FALSE', subsystemId: '41' },
      ],
      network: [],
    },
    lastPolledAt: 1,
    lastOk: true,
    pollTimer: null,
    polling: false,
  }
}

describe('remote-cache broadcast patching', () => {
  beforeEach(seed)

  it('UpdateState flips a single tag state', () => {
    applyBroadcastToCache({ type: 'UpdateState', subsystemId: '41', id: 100, state: true })
    const tags = getCachedTagsForMcm('41')
    expect(tags.find((t) => t.id === 100)?.state).toBe('TRUE')
    expect(tags.find((t) => t.id === 101)?.state).toBe('FALSE')
  })

  it('TagSnapshot applies a batch of states', () => {
    applyBroadcastToCache({
      type: 'TagSnapshot',
      subsystemId: '41',
      states: [
        { id: 100, state: true },
        { id: 101, state: true },
      ],
    })
    const tags = getCachedTagsForMcm('41')
    expect(tags.every((t) => t.state === 'TRUE')).toBe(true)
  })

  it('NetworkStatusChanged updates the MCM connection flag + status', () => {
    applyBroadcastToCache({ type: 'NetworkStatusChanged', subsystemId: '41', status: 'connected' })
    const mcm = getCachedMcm('41')
    expect(mcm?.connected).toBe(true)
    expect(mcm?.status).toBe('connected')
  })

  it('TagStatusUpdate updates connectivity', () => {
    applyBroadcastToCache({ type: 'TagStatusUpdate', subsystemId: '41', connected: true })
    expect(getCachedMcm('41')?.connected).toBe(true)
  })

  it('ignores malformed / unknown messages without throwing', () => {
    expect(() => applyBroadcastToCache(null)).not.toThrow()
    expect(() => applyBroadcastToCache('nope' as unknown)).not.toThrow()
    expect(() => applyBroadcastToCache({ type: 'Whatever' })).not.toThrow()
    // unchanged
    expect(getCachedState().mcms.length).toBe(1)
  })

  it('does not cross-patch tags belonging to another subsystem', () => {
    applyBroadcastToCache({ type: 'UpdateState', subsystemId: '99', id: 100, state: true })
    // subsystem mismatch -> no change
    expect(getCachedTagsForMcm('41').find((t) => t.id === 100)?.state).toBe('FALSE')
  })
})
