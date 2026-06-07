/**
 * Pure helpers for the VFD wizard's "Bump Blocker" L2 cell.
 *
 * When a Bump Test (Step 3) fails and the operator records a blocker, the
 * choice is persisted in a dedicated L2 column named `Bump Blocker` so it
 * survives wizard reopen, shows on other laptops, and is audited via
 * `l2_cell_history` — mirroring the Polarity / Speed Set Up enriched-stamp
 * convention used elsewhere in the wizard.
 *
 * Cell format: `"<stamp> · <party> · <description>"`
 *   - `<stamp>`       — the same initials+date stamp Step 3 already writes for
 *                       `Check Direction` (e.g. "ASH 9/5").
 *   - `<party>`       — VfdBlockerParty ('Controls' | 'Electrical' | 'Mechanical').
 *   - `<description>` — the FINAL blocker description (Other already folded in
 *                       as "Other: <text>"). May itself contain " · ", which is
 *                       why parsing rejoins everything after the party segment.
 *
 * An empty / missing / unparseable cell means "not blocked".
 */

const SEP = ' · '

export function formatBumpBlockerCell(stamp: string, party: string, description: string): string {
  return `${stamp}${SEP}${party}${SEP}${description}`
}

export function parseBumpBlockerCell(
  value: string | null | undefined,
): { party: string; description: string } | null {
  if (!value || !value.trim()) return null
  const parts = value.split(SEP)
  // Need at least stamp + party + description.
  if (parts.length < 3) return null
  const party = (parts[1] ?? '').trim()
  const description = parts.slice(2).join(SEP).trim()
  if (!party || !description) return null
  return { party, description }
}
