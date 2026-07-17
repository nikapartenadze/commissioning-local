/**
 * Cloud Sync dialog parked-queue summary — must reflect ALL 5 queue kinds so the
 * modal matches the toolbar badge (not just FV).
 */
import { describe, it, expect } from 'vitest'
import { summarizeParked } from '@/lib/sync/parked-summary'

describe('summarizeParked', () => {
  it('counts by kind across all 5 queues + total', () => {
    const r = summarizeParked([
      { kind: 'l2' }, { kind: 'l2' }, { kind: 'io' }, { kind: 'estop' }, { kind: 'guided' }, { kind: 'blocker' },
    ])
    expect(r.total).toBe(6)
    expect(r.byKind).toMatchObject({ l2: 2, io: 1, estop: 1, guided: 1, blocker: 1 })
  })

  it('summaryLine is human, most-common first, with friendly labels', () => {
    const r = summarizeParked([{ kind: 'l2' }, { kind: 'l2' }, { kind: 'estop' }])
    expect(r.summaryLine).toBe('2 FV · 1 E-stop')
  })

  it('empty → total 0, empty line', () => {
    const r = summarizeParked([])
    expect(r.total).toBe(0)
    expect(r.summaryLine).toBe('')
  })
})
