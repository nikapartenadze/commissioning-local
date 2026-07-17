/**
 * Sync Center reason classifier — "real reasons, no unknown stuck".
 * Every surfaced stuck row must get an actionable, human reason; a row that HAS
 * a cloud error text must never read as a bare "Unknown sync error."
 */
import { describe, it, expect } from 'vitest'
import { classify } from '@/lib/sync/queue-inspector'

describe('classify', () => {
  it('403/404/410 → gone_on_cloud', () => {
    expect(classify('HTTP 404').classification).toBe('gone_on_cloud')
    expect(classify('HTTP 410 — target no longer exists on cloud').classification).toBe('gone_on_cloud')
    expect(classify('IO not found').classification).toBe('gone_on_cloud')
  })

  it('version/409/updatedCount=0 → version_conflict', () => {
    expect(classify('updatedCount=0 (version mismatch likely)').classification).toBe('version_conflict')
    expect(classify('HTTP 409 conflict').classification).toBe('version_conflict')
  })

  it('network/5xx/timeout → transient', () => {
    expect(classify('HTTP 500').classification).toBe('transient')
    expect(classify('HTTP 503 (network-level, no strike)').classification).toBe('transient')
    expect(classify('fetch failed: ETIMEDOUT').classification).toBe('transient')
  })

  it('THE FIX: a 4xx value rejection / retry-cap / SPARE → cloud_rejected (not "unknown"), with the raw text', () => {
    for (const e of ['HTTP 400', 'HTTP 422', 'SPARE cannot be Passed', 'estop retry cap exhausted', 'L2 retry cap exhausted']) {
      const r = classify(e)
      expect(r.classification).toBe('cloud_rejected')
      expect(r.reason).toContain(e) // raw cloud text surfaced
    }
  })

  it('an unrecognised BUT present error is surfaced verbatim, never a bare "unknown"', () => {
    const r = classify('weird gateway hiccup zzz')
    expect(r.classification).toBe('unknown')
    expect(r.reason).toBe('Cloud said: weird gateway hiccup zzz')
    expect(r.reason).not.toBe('Unknown sync error.')
  })

  it('only a truly EMPTY error is the generic unknown', () => {
    expect(classify(null).classification).toBe('unknown')
    expect(classify('').classification).toBe('unknown')
    // and even then the reason is actionable (retry/discard), not a dead "Unknown sync error."
    expect(classify(null).reason).toMatch(/retry|discard/i)
  })
})
