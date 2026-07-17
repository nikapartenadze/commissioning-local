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
/**
 * True when a POST /api/vfd-commissioning/write-l2-cells response is a BENIGN
 * "column not on this sheet" drop — HTTP 422 where EVERY failure is a
 * column-not-found. That route 422s ONLY for the column-not-found branch
 * (genuine write failures are 500 or a thrown fetch error), so a 422 here means
 * the template simply doesn't have that column (e.g. an un-provisioned synthetic
 * "Run Verified" on a legacy sheet). The operator's other cells still saved and
 * the drop is journalled server-side, so the wizard should skip quietly rather
 * than fire a destructive "NOT saved — redo this step" toast. Returns false for
 * a genuine failure (500 / network / mixed errors) so those still surface loud.
 */
export function isMissingColumnDrop(
  status: number,
  body: { written?: Array<{ ok?: boolean; error?: string }>; dropped?: unknown[] } | null | undefined,
): boolean {
  if (status !== 422 || !body) return false
  const dropped = Array.isArray(body.dropped) ? body.dropped : []
  if (dropped.length === 0) return false
  const written = Array.isArray(body.written) ? body.written : []
  // Every non-ok entry must be a column-not-found; any other error → not benign.
  return written.every((w) => !!w?.ok || /not found in sheet/i.test(String(w?.error || '')))
}

export function shouldClearBlockerOnTestRunPass(args: {
  /** True only when the Test Run step raised the current blocker this session. */
  raisedThisSession: boolean
  /** The blocker in the shared slot at confirm time (null = not blocked). */
  blocker: { party: string; description: string } | null
}): boolean {
  return args.raisedThisSession && args.blocker != null
}

/**
 * Resolve whether a VFD device is BLOCKED, merging this box's local Bump Blocker
 * cell with the cloud-authoritative VfdBlocker mirror (a blocker raised on
 * ANOTHER box). Precedence, most-authoritative first:
 *
 *   1. The local Bump Blocker CELL, when non-empty — a blocker this box raised.
 *   2. If the local cell is EMPTY but there's an IN-FLIGHT local blocker op for
 *      this device (a set/clear the tech just made on THIS box, still queued in
 *      DeviceBlockerPendingSyncs), the LOCAL state is authoritative → NOT blocked
 *      from the mirror. This is the fix for the stale-mirror window: after a
 *      local CLEAR, the cell is blank but the mirror still holds the pre-clear
 *      row (the mirror is only pruned during a pull), so without this guard the
 *      belt wrongly reads blocked on the very box that just cleared it until the
 *      next pull. Mirrors the pending-guard in vfd-blocker-mirror-repository.
 *   3. Otherwise the cloud mirror decides (a blocker from another box).
 *
 * Returns the active blocker { party, description } or null when not blocked.
 */
export function resolveDeviceBlocked(
  cellBlocker: { party: string; description: string } | null,
  mirrored: { party: string | null; description: string | null } | null | undefined,
  hasPendingLocalOp: boolean,
): { party: string; description: string } | null {
  if (cellBlocker) return cellBlocker
  // Local cell empty. An in-flight local op means the tech just changed this on
  // THIS box — the cell (now empty = cleared) wins; the mirror must not override.
  if (hasPendingLocalOp) return null
  if (mirrored && (mirrored.party || mirrored.description)) {
    return { party: mirrored.party ?? '', description: mirrored.description ?? '' }
  }
  return null
}
