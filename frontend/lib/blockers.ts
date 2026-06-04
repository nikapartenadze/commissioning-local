// HAND-MIRROR of commissioning-cloud/lib/blockers.ts. If you edit one, edit the
// other — the party list + per-party descriptions must match across repos because
// all apps share the Devices.BlockerResponsibleParty / BlockerDescription columns
// (and installation-tracker's BLOCKER_RESPONSIBLE_PARTIES must match the party list).

export const BLOCKER_PARTIES = ['Mechanical', 'Electrical', 'Controls', '3rd Party'] as const
export type BlockerParty = (typeof BLOCKER_PARTIES)[number]

export const BLOCKER_VOCAB: Record<BlockerParty, string[]> = {
  Mechanical: ['Guard rail missing', 'Side guard not installed', 'Not aligned (mechanical)', 'Other'],
  Electrical: ['Not installed', 'Not powered', 'Not aligned', 'Wrong wiring', 'Damaged', 'Temp install', 'Other'],
  Controls: ['Not programmed', 'Missing drawings', 'Config error', 'Wrong tag', 'Other'],
  '3rd Party': ['Vendor blocked', 'Awaiting vendor', 'Other'],
}
