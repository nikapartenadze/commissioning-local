import { describe, it, expect, vi } from 'vitest'
import { pullExtraSections } from '@/lib/cloud/pull-extra-sections'

/**
 * pullExtraSections composes the manual-pull sections that runConfigSidePulls
 * does NOT cover — VFD blockers, VFD addressed, roadmap, MCM diagram — so a
 * manual "Pull IOs from Cloud" refreshes them too. Each section is independent
 * and best-effort: one failing must not abort the others, and every section is
 * subsystem-scoped by argument (never by the ambient config subsystem).
 */
describe('pullExtraSections', () => {
  const injected = () => ({
    pullVfdBlockers: vi.fn(async () => 3),
    pullVfdAddressed: vi.fn(async () => 2),
    pullRoadmap: vi.fn(async () => 1),
    pullMcmDiagram: vi.fn(async () => 1),
  })

  it('aggregates every section count and passes the SAME subsystem + creds to each', async () => {
    const deps = injected()
    const res = await pullExtraSections(42, 'http://cloud', 'key', deps)
    expect(res).toEqual({ vfdBlockersPulled: 3, vfdAddressedPulled: 2, roadmapPulled: 1, mcmDiagramPulled: 1 })
    for (const fn of Object.values(deps)) {
      expect(fn).toHaveBeenCalledWith(42, { remoteUrl: 'http://cloud', apiPassword: 'key' })
    }
  })

  it('is best-effort: one section throwing yields 0 for it and never fails the others', async () => {
    const deps = injected()
    deps.pullRoadmap = vi.fn(async () => { throw new Error('roadmap endpoint down') })
    const res = await pullExtraSections(42, 'http://cloud', 'key', deps)
    expect(res).toEqual({ vfdBlockersPulled: 3, vfdAddressedPulled: 2, roadmapPulled: 0, mcmDiagramPulled: 1 })
  })
})
