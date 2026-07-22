import { describe, it, expect } from 'vitest'
import {
  deriveWizardCellState,
  mergeLiveWizardCellState,
  applyBeltGate,
  shouldRaiseUntrackNotice,
  BELT_GATE_STEP,
  BELT_GATED_STEPS,
  type WizardGateCells,
  type WizardCellState,
} from '@/lib/vfd-wizard-gate'

/**
 * REGRESSION: 2026-07-22, MCM15.
 *
 * `beltTrackedDone` in vfd-wizard-modal.tsx was a ONE-WAY latch — a non-empty
 * "Belt Tracked" cell set it true, and only a full Clear Test set it back. With
 * the restore effect keyed on the device name it ran once, on open. So a
 * coordinator untracking a belt cleared the cell and the writer retracted the
 * flag on the controller, while an already-open wizard still showed steps 4/5
 * unlocked. Pressing Normal/Inverter there wrote the validation chain — belt
 * flag included — straight back to a controller four tool instances shared.
 * Belts untracked at 12:37 were still flagged at 16:30.
 */

const NO_CELLS: WizardGateCells = {}

const TRACKED: WizardGateCells = {
  verifyIdentity: 'ASH 7/22',
  motorHpField: '5',
  vfdHpField: '5',
  checkDirection: 'ASH 7/22',
  runVerified: 'ASH 7/22',
  beltTracked: 'MECH 7/22',
  speedSetUp: 'ASH 7/22 · 200 FPM @ 25.30 RVS',
}

describe('belt-tracking gate — the cell must be followed in BOTH directions', () => {
  it('cell filled → gate open', () => {
    expect(deriveWizardCellState(TRACKED).beltTrackedDone).toBe(true)
  })

  it('THE BUG: cell goes empty → gate CLOSES (was latched open forever)', () => {
    const untracked = { ...TRACKED, beltTracked: null }
    expect(deriveWizardCellState(untracked).beltTrackedDone).toBe(false)
  })

  it('cell repopulates → gate reopens', () => {
    const untracked = { ...TRACKED, beltTracked: '' }
    expect(deriveWizardCellState(untracked).beltTrackedDone).toBe(false)
    const retracked = { ...TRACKED, beltTracked: 'MECH 7/23' }
    expect(deriveWizardCellState(retracked).beltTrackedDone).toBe(true)
  })

  it('a whitespace-only stamp is not "tracked"', () => {
    expect(deriveWizardCellState({ ...TRACKED, beltTracked: '   ' }).beltTrackedDone).toBe(false)
  })

  it('a device whose sheet has no Belt Tracked column at all is unaffected', () => {
    // The column being absent yields undefined, exactly like an empty cell:
    // the gate stays shut and the other flags still derive normally. This is
    // the pre-existing behaviour and must not change.
    const noColumn: WizardGateCells = {
      verifyIdentity: 'ASH 7/22',
      motorHpField: '5',
      vfdHpField: '5',
      checkDirection: 'ASH 7/22',
      runVerified: 'ASH 7/22',
    }
    const state = deriveWizardCellState(noColumn)
    expect(state.beltTrackedDone).toBe(false)
    expect(state.identityDone).toBe(true)
    expect(state.directionDone).toBe(true)
    expect(state.hpFieldsFilled).toBe(true)
    expect(state.testRunDone).toBe(true)
  })

  it('an empty cell set derives every flag false', () => {
    expect(deriveWizardCellState(NO_CELLS)).toEqual({
      beltTrackedDone: false,
      testRunDone: false,
      identityDone: false,
      directionDone: false,
      speedSetUpDone: false,
      hpFieldsFilled: false,
    })
  })
})

describe('deriveWizardCellState — the other flags that used to latch one-way', () => {
  it('Test Run infers from downstream proof (Belt Tracked / Speed Set Up)', () => {
    expect(deriveWizardCellState({ beltTracked: 'MECH 7/22' }).testRunDone).toBe(true)
    expect(deriveWizardCellState({ speedSetUp: 'ASH 7/22' }).testRunDone).toBe(true)
    expect(deriveWizardCellState({ runVerified: 'ASH 7/22' }).testRunDone).toBe(true)
    expect(deriveWizardCellState({ controlsVerified: 1 }).testRunDone).toBe(true)
    expect(deriveWizardCellState({}).testRunDone).toBe(false)
  })

  it('HP needs BOTH cells, not either', () => {
    expect(deriveWizardCellState({ motorHpField: '5' }).hpFieldsFilled).toBe(false)
    expect(deriveWizardCellState({ vfdHpField: '5' }).hpFieldsFilled).toBe(false)
    expect(deriveWizardCellState({ motorHpField: '5', vfdHpField: '5' }).hpFieldsFilled).toBe(true)
  })
})

describe('mergeLiveWizardCellState — only the belt gate may regress on a live push', () => {
  const earned: WizardCellState = {
    beltTrackedDone: true, testRunDone: true, identityDone: true,
    directionDone: true, speedSetUpDone: true, hpFieldsFilled: true,
  }

  it('an untrack arriving mid-session closes the gate', () => {
    const merged = mergeLiveWizardCellState(earned, deriveWizardCellState({ ...TRACKED, beltTracked: null }))
    expect(merged.beltTrackedDone).toBe(false)
  })

  it('does NOT undo work the operator just did while its L2 write is in flight', () => {
    // The re-read still shows blank cells because the write has not landed.
    const merged = mergeLiveWizardCellState(earned, deriveWizardCellState(NO_CELLS))
    expect(merged.testRunDone).toBe(true)
    expect(merged.identityDone).toBe(true)
    expect(merged.directionDone).toBe(true)
    expect(merged.speedSetUpDone).toBe(true)
    expect(merged.hpFieldsFilled).toBe(true)
    // ...but the gate STILL closes. That is the whole point.
    expect(merged.beltTrackedDone).toBe(false)
  })

  it('still upgrades flags another laptop filled in', () => {
    const nothing: WizardCellState = {
      beltTrackedDone: false, testRunDone: false, identityDone: false,
      directionDone: false, speedSetUpDone: false, hpFieldsFilled: false,
    }
    const merged = mergeLiveWizardCellState(nothing, deriveWizardCellState(TRACKED))
    expect(merged).toEqual({
      beltTrackedDone: true, testRunDone: true, identityDone: true,
      directionDone: true, speedSetUpDone: true, hpFieldsFilled: true,
    })
  })

  it('re-tracking reopens the gate on the live path too', () => {
    const closed = mergeLiveWizardCellState(earned, deriveWizardCellState({ beltTracked: null }))
    expect(closed.beltTrackedDone).toBe(false)
    const reopened = mergeLiveWizardCellState(closed, deriveWizardCellState({ beltTracked: 'MECH 7/23' }))
    expect(reopened.beltTrackedDone).toBe(true)
  })
})

describe('applyBeltGate — the cascade must actually collapse', () => {
  const allDone = [true, true, true, true, true, true]

  it('tracked → cascade untouched', () => {
    expect(applyBeltGate(allDone, true)).toEqual(allDone)
  })

  it('THE BUG: untracked → steps 4 and 5 are forced not-done', () => {
    // Without this, `lastTrueRef` holds the previous `true` (nulls are ignored
    // by design so a PLC read blip cannot flash the cascade red), firstBadIndex
    // stays -1, canGoTo(5) stays true and the auto-snap never fires.
    expect(applyBeltGate(allDone, false)).toEqual([true, true, true, true, false, false])
  })

  it('firstBadIndex lands on the gate step, so the operator is snapped back to it', () => {
    const gated = applyBeltGate(allDone, false)
    expect(gated.findIndex(d => !d)).toBe(BELT_GATE_STEP)
  })

  it('never un-breaks an earlier step', () => {
    const brokenAtTwo = [true, true, false, false, false, false]
    expect(applyBeltGate(brokenAtTwo, false)).toEqual(brokenAtTwo)
    expect(applyBeltGate(brokenAtTwo, false).findIndex(d => !d)).toBe(2)
  })

  it('gates exactly the post-track steps', () => {
    expect([...BELT_GATED_STEPS]).toEqual([4, 5])
  })
})

describe('shouldRaiseUntrackNotice — explain it, but only when it is a surprise', () => {
  it('raised when the gate closes on a post-gate step', () => {
    expect(shouldRaiseUntrackNotice(true, false, 4)).toBe(true)
    expect(shouldRaiseUntrackNotice(true, false, 5)).toBe(true)
  })

  it('not raised when the operator was upstream of the gate anyway', () => {
    expect(shouldRaiseUntrackNotice(true, false, 3)).toBe(false)
    expect(shouldRaiseUntrackNotice(true, false, 0)).toBe(false)
  })

  it('not raised on open — an already-untracked belt shows the step panel instead', () => {
    expect(shouldRaiseUntrackNotice(false, false, 5)).toBe(false)
  })

  it('not raised when the gate OPENS', () => {
    expect(shouldRaiseUntrackNotice(false, true, 5)).toBe(false)
  })
})

describe('Clear Test still works', () => {
  it('a cleared device derives every flag false — nothing latches through the reset', () => {
    // POST /clear blanks the L2 cells; the wizard re-reads and must land on a
    // clean slate rather than keeping the pre-clear latches.
    const state = deriveWizardCellState({
      verifyIdentity: null, motorHpField: null, vfdHpField: null,
      checkDirection: null, beltTracked: null, speedSetUp: null,
      runVerified: null, controlsVerified: null,
    })
    expect(state).toEqual({
      beltTrackedDone: false, testRunDone: false, identityDone: false,
      directionDone: false, speedSetUpDone: false, hpFieldsFilled: false,
    })
  })

  it('a cell still in flight during the clear re-read is honoured (non-live path takes cells at face value)', () => {
    // The Clear Test re-read uses the NON-live path, so a racing write that has
    // already landed is restored rather than dropped.
    const state = deriveWizardCellState({ verifyIdentity: 'ASH 7/22' })
    expect(state.identityDone).toBe(true)
    expect(state.beltTrackedDone).toBe(false)
  })
})
