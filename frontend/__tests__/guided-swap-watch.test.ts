import { describe, expect, it } from 'vitest'
import {
  createSwapWatch,
  isSpareIo,
  spareHitComment,
  swapComment,
  type SwapCandidateIo,
} from '@/lib/guided/swap-watch'

const PE2: SwapCandidateIo = { id: 2, name: 'UL21_2_TPE2', description: 'UL21_2 Jam PE 2' }
const SPARE: SwapCandidateIo = { id: 3, name: 'PDP02_SIO1_P5', description: 'SPARE' }
const FAR: SwapCandidateIo = { id: 4, name: 'UL23_9_TPE1', description: 'UL23_9 Jam PE' }

describe('createSwapWatch', () => {
  it('reports only after a FULL round-trip (away from idle AND back)', () => {
    const w = createSwapWatch([PE2], 'UL21_2_TPE1')
    expect(w.feed(2, 'TRUE')).toBeNull() // at idle (NC rests TRUE)
    expect(w.feed(2, 'FALSE')).toBeNull() // actuated — not yet a report
    const s = w.feed(2, 'TRUE') // returned — full trip
    expect(s).not.toBeNull()
    expect(s!.ioId).toBe(2)
  })

  it('anchors at the circuit idle: change-only events (actuate→return) report in 2 feeds', () => {
    // The tag reader broadcasts CHANGES only — the first event for a swapped
    // NC photoeye is the block (FALSE), then the clear (TRUE). That single
    // physical actuation must be enough to report.
    const w = createSwapWatch([PE2])
    expect(w.feed(2, 'FALSE')).toBeNull() // block (away from NC idle TRUE)
    expect(w.feed(2, 'TRUE')).not.toBeNull() // clear — full trip
  })

  it('a static or single-transition candidate never reports', () => {
    const w = createSwapWatch([PE2, FAR])
    expect(w.feed(2, 'TRUE')).toBeNull()
    expect(w.feed(2, 'TRUE')).toBeNull()
    expect(w.feed(4, 'TRUE')).toBeNull()
    expect(w.feed(4, 'FALSE')).toBeNull() // moved away, never returned
  })

  it('non-candidate ids (expected/tested IOs) are ignored', () => {
    const w = createSwapWatch([PE2])
    expect(w.feed(99, 'TRUE')).toBeNull()
    expect(w.feed(99, 'FALSE')).toBeNull()
    expect(w.feed(99, 'TRUE')).toBeNull()
  })

  it('reports at most once until re-armed', () => {
    const w = createSwapWatch([PE2])
    w.feed(2, 'TRUE')
    w.feed(2, 'FALSE')
    expect(w.feed(2, 'TRUE')).not.toBeNull()
    // flapping again does not re-fire…
    w.feed(2, 'FALSE')
    expect(w.feed(2, 'TRUE')).toBeNull()
    // …until an explicit rearm (dismiss)
    w.rearm(2)
    w.feed(2, 'TRUE')
    w.feed(2, 'FALSE')
    expect(w.feed(2, 'TRUE')).not.toBeNull()
  })

  it('same-device candidate scores high confidence, cross-device low', () => {
    const w = createSwapWatch([PE2, FAR], 'UL21_2')
    w.feed(2, 'TRUE'); w.feed(2, 'FALSE')
    expect(w.feed(2, 'TRUE')!.confidence).toBe('high')
    w.feed(4, 'TRUE'); w.feed(4, 'FALSE')
    expect(w.feed(4, 'TRUE')!.confidence).toBe('low')
  })

  it('flags SPARE candidates', () => {
    const w = createSwapWatch([SPARE])
    w.feed(3, 'FALSE'); w.feed(3, 'TRUE')
    expect(w.feed(3, 'FALSE')!.spare).toBe(true)
  })
})

describe('comments', () => {
  it('swapComment names both points and marks spares', () => {
    expect(swapComment('UL21_2 Jam PE 1', PE2)).toBe(
      'Swap detected: expected "UL21_2 Jam PE 1" but "UL21_2 Jam PE 2" triggered instead',
    )
    expect(swapComment('UL21_2 Jam PE 1', SPARE)).toContain('(SPARE point — must not be wired)')
  })
  it('spareHitComment references the expected point', () => {
    expect(spareHitComment('UL21_2 Jam PE 1')).toContain('SPARE point is wired')
  })
  it('isSpareIo is case-insensitive and null-safe', () => {
    expect(isSpareIo('Spare input')).toBe(true)
    expect(isSpareIo(null)).toBe(false)
  })
})
