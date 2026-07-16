import { describe, it, expect } from 'vitest'
import { networkErrorDeSpamKey } from '@/lib/plc/network/poller'

/**
 * The NetworkPoller firehose: a device under CIP saturation alternates
 * "Read failed: Timeout" / "Read failed: Busy" between 60s cycles. Keyed on the
 * raw message, that alternation reads as a NEW error every cycle and defeated
 * the heartbeat de-spam — ~94-98% of all field log volume. All transient
 * read/copy failures must collapse to ONE de-spam bucket.
 */
describe('networkErrorDeSpamKey', () => {
  it('collapses alternating transient read failures into one bucket', () => {
    const keys = [
      'Read failed: Timeout',
      'Read failed: Busy',
      'Bulk copy failed: Timeout',
      'Read failed: Not found',
    ].map(networkErrorDeSpamKey)
    // All the same → de-spam logs once per streak, not every cycle.
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('transient-read-failure')
  })

  it('keeps genuinely distinct non-transient errors separate', () => {
    const a = networkErrorDeSpamKey('Handle size mismatch: expected 830, got 12')
    const b = networkErrorDeSpamKey('UDT layout rejected')
    expect(a).not.toBe(b)
    expect(a).not.toBe('transient-read-failure')
  })
})
