/**
 * VFD wizard — belt-tracking gate state.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The wizard used to latch `beltTrackedDone` ONE WAY: the L2 "Belt Tracked"
 * cell being non-empty set it to true, and nothing except a full Clear Test
 * ever set it back to false. Combined with the restore effect being keyed on
 * `[device.deviceName]` (so it ran once, on open), an operator with the wizard
 * already open never saw a belt being UNtracked.
 *
 * That is not cosmetic. Steps 4/5 stayed unlocked, and pressing Normal/Inverter
 * on step 4 writes the validation chain — including the belt-tracking flag —
 * straight back to a SHARED controller. On 2026-07-22 belts untracked at 12:37
 * were still flagged at 16:30 because four tool instances shared one MCM and at
 * least one had a stale wizard open; the mechanics could not move the belt from
 * the keypad for ~4 hours.
 *
 * So the gate must FOLLOW the cell in both directions, and the wizard must be
 * able to re-derive it while it is open. The derivation is pulled out here as
 * pure functions so it can be tested without rendering the modal (the suite is
 * `environment: 'node'` and only picks up test files under `__tests__`).
 */

/**
 * The subset of `L2CommissioningCells` this module reasons about. Kept
 * structural (all optional) so the wizard's richer interface assigns to it and
 * a device whose sheet is missing a column simply yields `undefined`.
 */
export interface WizardGateCells {
  verifyIdentity?: string | null
  motorHpField?: string | null
  vfdHpField?: string | null
  checkDirection?: string | null
  beltTracked?: string | null
  speedSetUp?: string | null
  runVerified?: string | null
  /** Local SQLite fallback stamp; truthy-checked, not trimmed. */
  controlsVerified?: unknown
}

/** Wizard step-completion flags that are derived from L2 cells. */
export interface WizardCellState {
  beltTrackedDone: boolean
  testRunDone: boolean
  identityDone: boolean
  directionDone: boolean
  speedSetUpDone: boolean
  hpFieldsFilled: boolean
}

const filled = (v: string | null | undefined): boolean => Boolean(v && v.trim())

/**
 * Derive every cell-backed wizard flag from a freshly read cell set.
 *
 * Note this is TWO-WAY by construction: an empty cell yields `false`. Callers
 * decide whether they are allowed to act on a `false` (see
 * `mergeLiveWizardCellState`).
 */
export function deriveWizardCellState(cells: WizardGateCells): WizardCellState {
  const beltTrackedDone = filled(cells.beltTracked)
  return {
    beltTrackedDone,
    // Test Run is also inferred from downstream proof: Belt Tracked or Speed
    // Set Up being filled means Test Run must have happened, because those
    // steps gate on it.
    testRunDone:
      filled(cells.runVerified) ||
      Boolean(cells.controlsVerified) ||
      beltTrackedDone ||
      filled(cells.speedSetUp),
    identityDone: filled(cells.verifyIdentity),
    directionDone: filled(cells.checkDirection),
    speedSetUpDone: filled(cells.speedSetUp),
    hpFieldsFilled: filled(cells.motorHpField) && filled(cells.vfdHpField),
  }
}

/**
 * Merge a re-read that arrived while the wizard is OPEN.
 *
 * `beltTrackedDone` is the one flag allowed to regress here, and it is the only
 * one that has to: it is a safety gate written by somebody else (the mechanical
 * team, via cloud), so a live "no longer tracked" must close the gate at once.
 *
 * Everything else is upgrade-only on the live path. Those flags are written by
 * THIS wizard, and a re-read can race a write the operator just made (the
 * "Run Verified" L2 write and the controls-verified POST are both in flight for
 * a moment after the click). Letting a live re-read regress them would yank the
 * operator backwards off a step they just legitimately finished. They still
 * derive two-way on the open/Clear-Test paths, where nothing is in flight.
 */
export function mergeLiveWizardCellState(
  prev: WizardCellState,
  next: WizardCellState,
): WizardCellState {
  return {
    beltTrackedDone: next.beltTrackedDone,
    testRunDone: prev.testRunDone || next.testRunDone,
    identityDone: prev.identityDone || next.identityDone,
    directionDone: prev.directionDone || next.directionDone,
    speedSetUpDone: prev.speedSetUpDone || next.speedSetUpDone,
    hpFieldsFilled: prev.hpFieldsFilled || next.hpFieldsFilled,
  }
}

/** Step index the operator is sent back to when the gate closes (Bump Test). */
export const BELT_GATE_STEP = 4

/** Steps that may not be reached or actioned while the belt is not tracked. */
export const BELT_GATED_STEPS: readonly number[] = [4, 5]

/**
 * Force the belt-gated steps to "not done" in the cascade.
 *
 * The wizard's cascade caches the last non-null value per step (`lastTrueRef`)
 * so a transient PLC read returning `null` cannot flash the cascade red. That
 * cache is exactly why closing the gate is not enough on its own: dropping
 * steps 4/5 to `null` leaves the cached `true` in place, `firstBadIndex` stays
 * -1, and the auto-snap never fires. Applying the gate to the CASCADE OUTPUT
 * makes `firstBadIndex` land on the gate step, which drives both the snap-back
 * and `canGoTo`.
 */
export function applyBeltGate(stepDone: boolean[], beltTrackedDone: boolean): boolean[] {
  if (beltTrackedDone) return stepDone
  return stepDone.map((done, i) => (BELT_GATED_STEPS.includes(i) ? false : done))
}

/**
 * Should the operator be shown the "this belt was marked not tracked" notice?
 *
 * Only when the gate actually CLOSED (true -> false) while they were sitting on
 * or past a gated step. Opening the wizard on an untracked belt is not a
 * surprise — the step already renders its own waiting panel — so it must not
 * raise the notice.
 */
export function shouldRaiseUntrackNotice(
  prevBeltTrackedDone: boolean,
  nextBeltTrackedDone: boolean,
  activeStep: number,
): boolean {
  return prevBeltTrackedDone && !nextBeltTrackedDone && activeStep >= BELT_GATE_STEP
}
