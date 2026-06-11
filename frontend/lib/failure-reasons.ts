import type { PartyResponsible } from './party-responsible'

/**
 * Failure reasons for the "Mark as failed" dialog, grouped by the responsible
 * party each one derives to via getPartyResponsible(). The group label is shown
 * as a header in the dropdown; the value stored on the IO is the reason string,
 * which drives the cloud "Party Responsible" column.
 *
 * Mechanical reasons were added 2026-06-11 — previously the regular-Fail
 * dropdown had no Mechanical option, so mechanical issues ("guard rail missing")
 * leaked into the free-text comment and Party Responsible came out blank.
 *
 * EVERY reason here must map in lib/party-responsible.ts (and its hand-synced
 * cloud twin). The failure-reasons.test.ts guard enforces that — add a reason
 * without a party mapping and the test fails.
 */
export interface FailureReasonGroup {
  party: PartyResponsible | 'Other'
  reasons: string[]
}

export const FAILURE_REASON_GROUPS: FailureReasonGroup[] = [
  { party: 'Electrical', reasons: ['Not installed', 'Not powered', 'Not aligned', 'Wrong wiring', 'Damaged', 'Temp install'] },
  { party: 'Mechanical', reasons: ['Guard rail missing', 'Side guard not installed', 'Not aligned (mechanical)'] },
  { party: 'Controls', reasons: ['Not programmed', 'Missing drawings', 'Config error', 'Wrong tag'] },
  { party: '3rd Party', reasons: ['Vendor blocked', 'Awaiting vendor'] },
  { party: 'Other', reasons: ['Other'] },
]

/** Flat list of every reason (validation / legacy callers). */
export const FAILURE_REASONS: string[] = FAILURE_REASON_GROUPS.flatMap((g) => g.reasons)
