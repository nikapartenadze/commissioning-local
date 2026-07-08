import { describe, it, expect } from 'vitest'
import { verdictBadge, verdictHeadline } from '@/lib/ring-commissioning/verdict-format'

describe('verdictBadge', () => {
  it('maps kinds to colors', () => {
    expect(verdictBadge('match').color).toBe('green')
    expect(verdictBadge('wrong-port').color).toBe('red')
    expect(verdictBadge('missing').color).toBe('red')
    expect(verdictBadge('unexpected').color).toBe('amber')
  })
})
describe('verdictHeadline', () => {
  it('summarises healthy vs faults', () => {
    expect(verdictHeadline({ healthy: true, ringClosed: true, ringReason: 'ok', links: [], leafVerdicts: [], terminationFaults: [] }))
      .toMatch(/healthy/i)
    expect(verdictHeadline({ healthy: false, ringClosed: false, ringReason: 'Ring Fault', links: [], leafVerdicts: [], terminationFaults: [] }))
      .toMatch(/ring open|fault/i)
    expect(verdictHeadline({
      healthy: false, ringClosed: true, ringReason: 'ok',
      links: [{ kind: 'wrong-port', detail: 'x' }], leafVerdicts: [], terminationFaults: [],
    })).toMatch(/1 issue/i)
  })
})
