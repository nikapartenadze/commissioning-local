/**
 * Test: periodic cloud→field DELTA SWEEP (sweepConfiguredMcmsDelta).
 *
 * The sweep is the safety net for a LOST SSE `subsystem_changed` hint — it must
 * periodically run the SAME granular delta path the hint uses for every MANAGED
 * subsystem, so a missed hint can't leave a tablet stale. This locks down:
 *   - it runs the delta fetch once per ENABLED configured MCM (disabled skipped)
 *   - it reuses the shared delta path (fetchAndApplyDelta), not a second apply
 *   - the in-flight reentrancy guards (isSweeping / isPullingMcms) short-circuit
 *   - a field tablet with no MCM list falls back to the single config subsystem
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Hoisted spies referenced by the (hoisted) vi.mock factories.
const getMcms = vi.fn()
const getConfig = vi.fn(async () => ({ remoteUrl: 'http://cloud', apiPassword: 'k', subsystemId: '38' }))
const fetchAndApplyDelta = vi.fn(async () => ({
  resync: false as const,
  applied: 0,
  deleted: 0,
  skippedDeletes: [] as number[],
  sections: {},
}))

vi.mock('@/lib/db-sqlite', () => ({ db: {} }))
vi.mock('@/lib/config', () => ({ configService: { getMcms: (...a: any[]) => getMcms(...a), getConfig: (...a: any[]) => getConfig(...a) } }))
vi.mock('@/lib/cloud/delta-sync', () => ({ fetchAndApplyDelta: (...a: any[]) => fetchAndApplyDelta(...a) }))
vi.mock('@/lib/cloud/cloud-sse-client', () => ({ getCloudSseClient: () => null }))
vi.mock('@/lib/cloud/sync-cursor', () => ({ setSyncCursor: vi.fn() }))
vi.mock('@/lib/cloud/vfd-addressed-pull', () => ({ pullVfdAddressed: vi.fn(async () => 0) }))
vi.mock('@/lib/cloud/config-side-pulls', () => ({ runConfigSidePulls: vi.fn(async () => ({})) }))

import { sweepConfiguredMcmsDelta, createPullState } from '@/lib/cloud/auto-sync-pull'

describe('sweepConfiguredMcmsDelta', () => {
  beforeEach(() => {
    getMcms.mockReset()
    fetchAndApplyDelta.mockClear()
    getConfig.mockClear()
  })

  it('runs the delta fetch once per ENABLED managed MCM (disabled skipped)', async () => {
    getMcms.mockResolvedValue([
      { subsystemId: '38', enabled: true, ip: '11.200.1.2' },
      { subsystemId: '40', enabled: true },
      { subsystemId: '41', enabled: false }, // disabled → must be skipped
    ])
    const state = createPullState()
    await sweepConfiguredMcmsDelta(state, 'test')

    const swept = fetchAndApplyDelta.mock.calls.map((c) => (c as any[])[0]).sort()
    expect(swept).toEqual([38, 40])
    expect(state.isSweeping).toBe(false) // guard released
  })

  it('skips the whole tick while a sweep is already in flight', async () => {
    getMcms.mockResolvedValue([{ subsystemId: '38', enabled: true }])
    const state = createPullState()
    state.isSweeping = true
    await sweepConfiguredMcmsDelta(state, 'test')
    expect(fetchAndApplyDelta).not.toHaveBeenCalled()
  })

  it('skips the tick while the multi-MCM catch-up is running (no double-up)', async () => {
    getMcms.mockResolvedValue([{ subsystemId: '38', enabled: true }])
    const state = createPullState()
    state.isPullingMcms = true
    await sweepConfiguredMcmsDelta(state, 'test')
    expect(fetchAndApplyDelta).not.toHaveBeenCalled()
  })

  it('falls back to the single configured subsystem on a field tablet (no MCM list)', async () => {
    getMcms.mockResolvedValue([]) // field tablet — no configured MCMs
    getConfig.mockResolvedValue({ remoteUrl: 'http://cloud', apiPassword: 'k', subsystemId: '38' })
    const state = createPullState()
    await sweepConfiguredMcmsDelta(state, 'test')
    const swept = fetchAndApplyDelta.mock.calls.map((c) => (c as any[])[0])
    expect(swept).toEqual([38])
  })
})
