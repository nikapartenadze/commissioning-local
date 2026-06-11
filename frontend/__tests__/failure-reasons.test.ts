import { describe, it, expect } from 'vitest'
import { FAILURE_REASON_GROUPS, FAILURE_REASONS } from '@/lib/failure-reasons'
import { getPartyResponsible } from '@/lib/party-responsible'

/**
 * Guards the "Mark as failed" dropdown vocabulary against the party derivation.
 * The whole point of grouping the dropdown by party is that each reason maps to
 * the party it's shown under — a reason with no mapping would silently produce a
 * blank Party Responsible (the CDW5 bug). This test fails if anyone adds a
 * reason without a corresponding getPartyResponsible mapping.
 */
describe('failure-reason dropdown vocabulary', () => {
  it('every reason derives the party it is grouped under (Other → null)', () => {
    for (const group of FAILURE_REASON_GROUPS) {
      for (const reason of group.reasons) {
        if (group.party === 'Other') {
          expect(getPartyResponsible(reason), `${reason} should be unmapped`).toBeNull()
        } else {
          expect(getPartyResponsible(reason), `${reason} should map to ${group.party}`).toBe(group.party)
        }
      }
    }
  })

  it('includes the Mechanical reasons (the gap that left party blank)', () => {
    const mech = FAILURE_REASON_GROUPS.find((g) => g.party === 'Mechanical')
    expect(mech).toBeDefined()
    expect(mech!.reasons).toContain('Guard rail missing')
    expect(mech!.reasons).toContain('Side guard not installed')
  })

  it('has no duplicate reason strings across groups', () => {
    expect(new Set(FAILURE_REASONS).size).toBe(FAILURE_REASONS.length)
  })
})
