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
  // Normalise casing/whitespace before matching. Field data drifts ('Not
  // Installed' with a capital I, stray spaces), and an exact-case switch sent
  // those to null → a blank Party Responsible column. Since this is derived at
  // read time, normalising here retroactively fixes every existing row with no
  // backfill. Mirrors commissioning-cloud/lib/party-responsible.ts.
  const key = failureMode?.trim().toLowerCase()
  if (!key) return null
  switch (key) {
    // Legacy party-name vocabulary.
    case '3rd party': return '3rd Party'
    case 'mech': return 'Mechanical'
    case 'mechanical': return 'Mechanical'
    // Mechanical descriptive vocabulary (re-added v2.39.19 / 2026-06-03).
    case 'guard rail missing':
    case 'side guard not installed':
    case 'not aligned (mechanical)':
      return 'Mechanical'
    case 'electrical': return 'Electrical'
    case 'controls': return 'Controls'

    // Current descriptive vocabulary — Electrical bucket.
    case 'not installed':
    case 'not powered':
    case 'not aligned':
    case 'wrong wiring':
    case 'damaged':
    case 'temp install':
      return 'Electrical'

    // Current descriptive vocabulary — Controls bucket.
    case 'not programmed':
    case 'missing drawings':
    case 'config error':
    case 'wrong tag':
      return 'Controls'

    // Current descriptive vocabulary — 3rd Party bucket.
    case 'vendor blocked':
    case 'awaiting vendor':
      return '3rd Party'

    // Other / unknown → null. Comments column carries the detail.
    default: return null
  }
}
