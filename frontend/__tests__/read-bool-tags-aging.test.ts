/**
 * R9: the shared status-tag reader (lib/plc/read-bool-tags.ts) must not pin a
 * tag whose libplctag handle failed to create to null FOREVER. The old behavior
 * kept a failed tag in a sticky Set until a full PLC reconnect cleared it, so a
 * transient CIP-saturation failure left safety/network views showing a stale
 * false indefinitely. The failure entry must now age out after FAILED_TAG_TTL_MS
 * and be retried on a later poll.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const state = vi.hoisted(() => ({
  createCalls: 0,
  createResult: { successful: [] as string[], failed: [{ name: 'TAG1' }] as { name: string }[] },
  cachedValue: null as boolean | null,
  hasTag: false,
}))

vi.mock('@/lib/mcm-registry', () => ({
  readTypedTagsForMcm: vi.fn(async () => ({ connected: false, results: [] })),
}))

vi.mock('@/lib/plc-client-manager', () => ({
  getPlcClient: () => ({
    hasTag: (_n: string) => state.hasTag,
    readTagCached: (_n: string) => state.cachedValue,
    tagReader: {
      createTags: async (_names: string[]) => {
        state.createCalls++
        return state.createResult
      },
    },
  }),
}))

import { readBoolTagsBySubsystem, FAILED_TAG_TTL_MS } from '@/lib/plc/read-bool-tags'

const legacy = (tag: string) => ({
  registryTagsBySid: new Map<string, Set<string>>(),
  legacyTags: new Set([tag]),
  singletonConnected: true,
})

describe('readBoolTagsBySubsystem — R9 failedTags TTL aging', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-09T00:00:00Z'))
    state.createCalls = 0
    state.createResult = { successful: [], failed: [{ name: 'TAG1' }] }
    state.cachedValue = null
    state.hasTag = false
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pins a failed tag to null within the TTL, then retries after it expires', async () => {
    // 1) First read: creation fails → value null (not_found), created once.
    let out = await readBoolTagsBySubsystem(legacy('TAG1'))
    expect(state.createCalls).toBe(1)
    expect(out.values.TAG1).toBeNull()
    expect(out.diag.TAG1).toBe('not_found')

    // 2) Within the TTL: the entry is still sticky — NOT retried, still null.
    vi.advanceTimersByTime(FAILED_TAG_TTL_MS - 1000)
    out = await readBoolTagsBySubsystem(legacy('TAG1'))
    expect(state.createCalls).toBe(1)
    expect(out.values.TAG1).toBeNull()

    // 3) Past the TTL: the entry ages out and the tag is retried. This time
    //    creation succeeds and the cached read returns a real value.
    state.createResult = { successful: ['TAG1'], failed: [] }
    state.cachedValue = true
    vi.advanceTimersByTime(2000) // total elapsed now exceeds FAILED_TAG_TTL_MS
    out = await readBoolTagsBySubsystem(legacy('TAG1'))
    expect(state.createCalls).toBe(2)
    expect(out.values.TAG1).toBe(true)
    expect(out.diag.TAG1).toBe('ok')
  })
})
