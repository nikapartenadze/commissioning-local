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

/**
 * Whether a Test Run (Step 4) PASS may auto-clear the device blocker.
 *
 * Test Run and Bump Test (Step 3) share ONE blocker slot — the single
 * `Bump Blocker` L2 cell plus the shared `Devices.Blocker*` pair. On wizard
 * open the parent hydrates that one cell and hands the SAME value to both steps.
 * A hydrated blocker is therefore of UNKNOWN provenance: it may be a
 * bump/polarity fault raised at Step 3 in a prior session or on another laptop.
 *
 * Passing Test Run proves only that the drive STARTS and RUNS without an
 * immediate electrical/controls fault. It does NOT prove a belt-tracking /
 * polarity fault was fixed. So a Test Run pass may only auto-resolve a blocker
 * the Test Run step itself raised in THIS session; a hydrated/foreign blocker is
 * never wiped. Regression guard for the eager cross-step clear introduced in
 * 0ceecd4, which silently deleted unresolved bump-test blockers.
 *
 * The proper long-term fix is separate blocker slots per step; until then this
 * provenance check is the data-safe boundary.
 */
export function shouldClearBlockerOnTestRunPass(args: {
  /** True only when the Test Run step raised the current blocker this session. */
  raisedThisSession: boolean
  /** The blocker in the shared slot at confirm time (null = not blocked). */
  blocker: { party: string; description: string } | null
}): boolean {
  return args.raisedThisSession && args.blocker != null
}
