// HAND-MIRROR of commissioning-cloud/lib/blockers.ts. If you edit one, edit the
// other — the party list + per-party descriptions must match across repos because
// all apps share the Devices.BlockerResponsibleParty / BlockerDescription columns
// (and installation-tracker's BLOCKER_RESPONSIBLE_PARTIES must match the party list).
//
// This applies to BOTH the IO-check vocabulary (BLOCKER_PARTIES / BLOCKER_VOCAB)
// AND the VFD bump-test vocabulary (VFD_BLOCKER_PARTIES / VFD_BLOCKER_VOCAB) below.
// Both are hand-mirrored to commissioning-cloud/lib/blockers.ts.

export const BLOCKER_PARTIES = ['Mechanical', 'Electrical', 'Controls', '3rd Party'] as const
export type BlockerParty = (typeof BLOCKER_PARTIES)[number]

export const BLOCKER_VOCAB: Record<BlockerParty, string[]> = {
  Mechanical: ['Guard rail missing', 'Side guard not installed', 'Not aligned (mechanical)', 'Other'],
  Electrical: ['Not installed', 'Not powered', 'Not aligned', 'Wrong wiring', 'Damaged', 'Temp install', 'Other'],
  Controls: ['Not programmed', 'Missing drawings', 'Config error', 'Wrong tag', 'Other'],
  '3rd Party': ['Vendor blocked', 'Awaiting vendor', 'Other'],
}

// ── VFD bump-test blocker vocabulary ───────────────────────────────────────
// Separate from the IO-check BLOCKER_VOCAB above. Captured in the VFD wizard's
// Bump Test (Step 3) when the motor doesn't respond, then written to the SAME
// shared Devices.BlockerResponsibleParty / BlockerDescription columns. Three
// parties only — no 3rd Party. (Source: Kevin, taskboard #2170.) Hand-mirrored
// to commissioning-cloud/lib/blockers.ts.
export const VFD_BLOCKER_PARTIES = ['Controls', 'Electrical', 'Mechanical'] as const
export type VfdBlockerParty = (typeof VFD_BLOCKER_PARTIES)[number]

export const VFD_BLOCKER_VOCAB: Record<VfdBlockerParty, string[]> = {
  Controls: ['VFD did not turn on', 'Other'],
  Electrical: [
    'VFD Faults Immediately',
    'VFD Faults after Running',
    "VFD turns on, motor doesn't move, motor fan doesn't move",
    'Other',
  ],
  Mechanical: [
    'VFD turns on, drive shaft moves, belt is slipping',
    "VFD turns on, drive shaft doesn't move",
    'VFD turns on, belt moves, makes harsh noise',
    'Other',
  ],
}

/**
 * Final stored description. 'Other' requires a non-empty comment and stores
 * "Other: <comment>". Non-Other descriptions store verbatim; comment ignored.
 */
export function buildVfdBlockerDescription(description: string, comment?: string): string {
  if (description !== 'Other') return description
  const trimmed = (comment ?? '').trim()
  if (!trimmed) {
    throw new Error("A comment is required when the VFD blocker description is 'Other'")
  }
  return `Other: ${trimmed}`
}
