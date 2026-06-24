import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The SSE client imports the SQLite layer at module load. The subsystem_changed
// path never touches the DB, so a thin stub keeps this a pure unit test (no
// database.db file created on import).
vi.mock('@/lib/db-sqlite', () => ({
  db: { prepare: () => ({ get: () => undefined, run: () => {}, all: () => [] }) },
}))

import { CloudSseClient } from '@/lib/cloud/cloud-sse-client'

function makeClient() {
  return new CloudSseClient({ remoteUrl: 'http://x', apiPassword: 'k', subsystemId: 42 })
}

// handleEvent is private; tests reach it directly — it is the parse/dispatch seam
// the live stream loop feeds.
const feed = (c: CloudSseClient, ev: unknown) => (c as any).handleEvent(ev)

describe('CloudSseClient subsystem_changed', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires onSubsystemChanged once after debounce, coalescing rapid duplicates', () => {
    const client = makeClient()
    const seen: number[] = []
    client.onSubsystemChanged((sid) => seen.push(sid))

    feed(client, { type: 'subsystem_changed', data: { subsystemId: 42, seq: '0' } })
    feed(client, { type: 'subsystem_changed', data: { subsystemId: 42, seq: '0' } })
    feed(client, { type: 'subsystem-changed', data: { subsystemId: 42, seq: '0' } }) // hyphen variant

    expect(seen).toEqual([]) // debounced — nothing yet
    vi.advanceTimersByTime(2000)
    expect(seen).toEqual([42]) // three rapid hints collapsed to one pull
  })

  it('debounces each subsystemId independently', () => {
    const client = makeClient()
    const seen: number[] = []
    client.onSubsystemChanged((sid) => seen.push(sid))

    feed(client, { type: 'subsystem_changed', data: { subsystemId: 42 } })
    feed(client, { type: 'subsystem_changed', data: { subsystemId: 99 } })
    vi.advanceTimersByTime(2000)
    expect([...seen].sort((a, b) => a - b)).toEqual([42, 99])
  })

  it('ignores events with a missing or non-numeric subsystemId', () => {
    const client = makeClient()
    const seen: number[] = []
    client.onSubsystemChanged((sid) => seen.push(sid))

    feed(client, { type: 'subsystem_changed', data: {} })
    feed(client, { type: 'subsystem_changed', data: { subsystemId: 'abc' } })
    vi.advanceTimersByTime(2000)
    expect(seen).toEqual([])
  })

  it('stops firing after unsubscribe', () => {
    const client = makeClient()
    const seen: number[] = []
    const off = client.onSubsystemChanged((sid) => seen.push(sid))
    off()

    feed(client, { type: 'subsystem_changed', data: { subsystemId: 42 } })
    vi.advanceTimersByTime(2000)
    expect(seen).toEqual([])
  })
})
