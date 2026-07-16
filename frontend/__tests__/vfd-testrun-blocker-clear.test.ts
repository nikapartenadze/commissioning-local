import { describe, it, expect } from 'vitest'
import { shouldClearBlockerOnTestRunPass } from '@/lib/vfd-bump-blocker'

/**
 * Regression guard for 0ceecd4 (v2.43.3): Test Run PASS auto-cleared ANY blocker
 * in the shared slot — including an unresolved Bump-Test / polarity blocker
 * hydrated from a prior session or another laptop. Passing Test Run must only
 * clear a fault the Test Run step itself raised this session.
 */
describe('shouldClearBlockerOnTestRunPass', () => {
  const blocker = { party: 'Mechanical', description: 'belt runs backwards' }

  it('THE BUG: does NOT clear a hydrated/foreign blocker on Test Run pass', () => {
    // A bump/polarity blocker restored on wizard open — not raised at Test Run.
    expect(
      shouldClearBlockerOnTestRunPass({ raisedThisSession: false, blocker }),
    ).toBe(false)
  })

  it('clears a fault the Test Run step raised in this session', () => {
    expect(
      shouldClearBlockerOnTestRunPass({ raisedThisSession: true, blocker }),
    ).toBe(true)
  })

  it('does nothing when there is no blocker at all', () => {
    expect(
      shouldClearBlockerOnTestRunPass({ raisedThisSession: true, blocker: null }),
    ).toBe(false)
    expect(
      shouldClearBlockerOnTestRunPass({ raisedThisSession: false, blocker: null }),
    ).toBe(false)
  })
})
