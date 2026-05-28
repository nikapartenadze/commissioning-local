export type PartyResponsible = 'Electrical' | 'Mechanical' | 'Controls' | '3rd Party'

/** Derives the responsible party from a failure reason. Mirrors
 *  commissioning-cloud/lib/party-responsible.ts — kept in sync by hand
 *  because the two apps live in separate repos. If you edit one, edit
 *  the other.
 *
 *  Two vocabularies are supported:
 *
 *  1. Legacy "who" vocabulary — older builds picked a party name directly.
 *     'Mech' is preserved for older test history rows.
 *
 *  2. Current descriptive vocabulary (v2.39.7+) — Fail dialog picks a
 *     specific failure reason from a flat list. Each reason maps to one
 *     of the three parties the IO-check tool can assign. Mechanical is
 *     never an output — that's reassigned in the installation tracker.
 *
 *  Buckets mirror BLOCKER_DESCRIPTIONS in fail-comment-dialog.tsx. 'Other'
 *  returns null on purpose: when the tester picks Other they must type a
 *  comment, so the detail lives in the Comments column and the Party
 *  Responsible column stays blank.
 */
export function getPartyResponsible(failureMode?: string | null): PartyResponsible | null {
  switch (failureMode) {
    // Legacy party-name vocabulary.
    case '3rd Party': return '3rd Party'
    case 'Mech': return 'Mechanical'
    case 'Mechanical': return 'Mechanical'
    case 'Electrical': return 'Electrical'
    case 'Controls': return 'Controls'

    // Current descriptive vocabulary — Electrical bucket.
    case 'Not installed':
    case 'Not powered':
    case 'Not aligned':
    case 'Wrong wiring':
    case 'Damaged':
    case 'Temp install':
      return 'Electrical'

    // Current descriptive vocabulary — Controls bucket.
    case 'Not programmed':
    case 'Missing drawings':
    case 'Config error':
    case 'Wrong tag':
      return 'Controls'

    // Current descriptive vocabulary — 3rd Party bucket.
    case 'Vendor blocked':
    case 'Awaiting vendor':
      return '3rd Party'

    // Other / unknown → null. Comments column carries the detail.
    default: return null
  }
}
