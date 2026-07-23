/**
 * SERVER-SIDE belt-tracking gate for the VFD commissioning tag-write routes.
 *
 * WHY THIS EXISTS
 * ---------------
 * `POST /api/vfd-commissioning/write-tag` and `.../write-tags-batch` used to
 * validate presence and type ONLY. Any client — a stale wizard, a curl, a
 * second laptop on the same MCM — could latch `Tracking_Finished` on any
 * device by name.
 *
 * Latching Tracking_Finished takes belt direction away from the mechanics'
 * keypad. On 2026-07-22 that cost roughly four hours of mechanics' time on
 * MCM15, and a coordinator "helping" by inverting belts through the tool
 * re-locked four of them.
 *
 * 9d9a826 fixed the wizard so it falls back when the "Belt Tracked" cell
 * clears. That is a UI flag, and a UI flag is not a guard: it only constrains
 * the one client that happens to be running the new build. This module is the
 * server-side backstop, evaluated on the box that owns the PLC connection.
 *
 * ── AOI GROUND TRUTH (AOI_IOCT_BELT_TRACKING_AOI222.L5X) ─────────────────
 * Read out of the L5X. Do NOT re-derive it from comments in this repo —
 * several are wrong, including one that cited a nonexistent "rung 13".
 *
 *   rung 1: Valid_Map latches from CMD.Valid_Map (needs Check_Allowed);
 *           Valid_HP latches from CMD.Valid_HP (needs Valid_Map).
 *           Invalidate_Map / Invalidate_HP unlatch them.
 *   rungs 2,3,4,5: ALL gated XIC(Valid_HP) — Valid_HP=1 is the master enable
 *           for every operator keypad function (F1 start/stop, F0+F2
 *           direction, F0/F2 speed).
 *   rung 3: holds Tracking_Finished. WHILE LATCHED the tool owns polarity and
 *           the keypad cannot change direction.
 *   rung 6: OTL(Valid_Direction) requires Tracking_Finished; gates
 *           Run_At_30_RVS.
 *   rung 7: UNCONDITIONAL Reverse_Polarity -> DirectionCmd. Changing polarity
 *           on a MOVING belt reverses it under power.
 *   rung 8: FLL(0, CTRL.CMD, 1) every scan — every CMD write is a
 *           self-clearing one-scan pulse.
 *
 * ── WHAT IS GATED, AND WHY THAT LIST ─────────────────────────────────────
 * Post-gate = "the tool is asserting authority over a belt". Every field below
 * either takes the keypad away, or only makes sense once it already has:
 *
 *   Tracking_Finished  rung 3 — THE latch. Directly removes keypad direction.
 *   Valid_Direction    rung 6 — only latches behind Tracking_Finished, and
 *                      gates Run_At_30_RVS.
 *   Reverse_Polarity   rung 3 branch 4 — honoured only while the latch is set,
 *   Normal_Polarity    and rung 7 maps polarity onto DirectionCmd
 *                      unconditionally. This is the pair the wizard's polarity
 *                      step sends, and the pair the coordinator re-locked four
 *                      belts with.
 *   Bump               commands drive motion from the tool.
 *   Run_At_30_RVS      commands drive motion from the tool (behind
 *                      Valid_Direction, i.e. behind the latch).
 *   Speed_At_30rev     the HMI speed write (pathScope='HMI',
 *                      <dev>.HMI.Speed_At_30rev) — calibration, which is a
 *                      post-tracking step.
 *
 * PRE-GATE stays open: Valid_Map and Valid_HP come from local wizard truth
 * (identity + HP cells), not from any belt-tracking decision. Gating them
 * would take the keypad away too (rungs 2-5 are the Valid_HP gate) — the exact
 * failure this whole effort exists to stop. Same reasoning as
 * vfd-validation-writer's BELT_TRACKING_GATED_FIELDS, which deliberately
 * excludes them.
 *
 * RETRACTION is ALWAYS open. Invalidate_Tracking_Finished and
 * Invalidate_Direction can only UNLATCH. Refusing them because a belt is
 * untracked is precisely backwards: an untracked belt with a stale latch is
 * the state we most need to be able to clear.
 *
 * ── SHAPE OF THE RULE ────────────────────────────────────────────────────
 * A CLOSED deny-set, not an allowlist. The deny-set names exactly the writes
 * that can take a belt from the mechanics; everything else (identity, HP, the
 * Speed_FPM read-back, the rung-1 invalidates) passes. An allowlist would be
 * tighter in the abstract, but this route is the only write path the field
 * tool has and a mis-scoped allowlist refuses legitimate commissioning at 2am.
 * The deny-set is the load-bearing control and it is complete with respect to
 * the ladder.
 *
 * Matching is CASE-INSENSITIVE and trimmed. Logix tag names are
 * case-insensitive, so `tracking_finished` addresses the same bit as
 * `Tracking_Finished`; a case-sensitive deny-set would be a one-keystroke
 * bypass.
 *
 * Gating is by FIELD, regardless of value. A CMD bit written as 0 is a no-op
 * (every rung tests CMD with XIC and rung 8 zeroes it every scan), so refusing
 * value=0 costs nothing and removes a value-based bypass.
 *
 * PURE. No DB, no DLL, no controller — the lookup lives in ./belt-tracked-lookup.
 */

import { BELT_TRACKED_COLUMN_NAME } from '@/lib/vfd-validation-writer'

export { BELT_TRACKED_COLUMN_NAME }

/** CTRL.CMD fields refused while the belt is untracked. */
export const POST_GATE_CMD_FIELDS: readonly string[] = [
  'Tracking_Finished',
  'Valid_Direction',
  'Bump',
  'Run_At_30_RVS',
  'Reverse_Polarity',
  'Normal_Polarity',
]

/**
 * HMI-scope fields refused while the belt is untracked. `Speed_At_30rev` is
 * written as `<deviceName>.HMI.Speed_At_30rev` (pathScope='HMI') by the
 * wizard's Calibrate Speed step.
 */
export const POST_GATE_HMI_FIELDS: readonly string[] = ['Speed_At_30rev']

/**
 * Retraction fields. NEVER gated, in either direction — they can only unlatch,
 * and an untracked belt holding a stale latch is exactly when they are needed.
 * (Invalidate_Map / Invalidate_HP are rung-1 and also ungated; they are simply
 * absent from the post-gate sets rather than listed here.)
 */
export const ALWAYS_ALLOWED_FIELDS: readonly string[] = [
  'Invalidate_Tracking_Finished',
  'Invalidate_Direction',
]

const norm = (f: string): string => f.trim().toLowerCase()

const POST_GATE_SET = new Set(
  [...POST_GATE_CMD_FIELDS, ...POST_GATE_HMI_FIELDS].map(norm),
)
const ALWAYS_ALLOWED_SET = new Set(ALWAYS_ALLOWED_FIELDS.map(norm))

/**
 * Is this write one that asserts belt authority?
 *
 * Field name alone — the HMI field is gated regardless of pathScope, because
 * there is no CTRL.CMD.Speed_At_30rev for it to be confused with and a
 * pathScope-conditional rule is one more thing a caller can get wrong.
 */
export function isPostGateField(field: string): boolean {
  const f = norm(field)
  if (ALWAYS_ALLOWED_SET.has(f)) return false
  return POST_GATE_SET.has(f)
}

/**
 * Belt-tracking state as resolved from the local L2 cell.
 *
 *  - `resolved: false`        the device could not be judged (no L2 row on a
 *                             VFD/APF sheet). NOT gated — see judgeWrite.
 *  - `hasColumn: false`       the device's sheet defines no 'Belt Tracked'
 *                             column at all. NOT gated: not every template has
 *                             belt tracking, and gating those sheets would
 *                             break commissioning that never involved a belt.
 *  - `hasColumn: true`        `tracked` is the cell's filled/empty state.
 *  - `error`                  the lookup itself failed.
 */
export type BeltTrackedState =
  | { resolved: false; error?: string }
  | { resolved: true; hasColumn: false }
  | { resolved: true; hasColumn: true; tracked: boolean }

export type GateCode =
  /** Not a belt-authority field — identity, HP, Valid_Map/Valid_HP, read-backs. */
  | 'pre_gate_field'
  /** A retraction. Always permitted. */
  | 'retraction_field'
  /** Post-gate field, and the belt is tracked. */
  | 'belt_tracked'
  /** The device's sheet has no 'Belt Tracked' column — this template has no gate. */
  | 'no_belt_tracking_column'
  /** The device has no L2 row on a VFD/APF sheet — nothing to judge. */
  | 'device_not_in_l2'
  /** REFUSED: post-gate field on a belt whose 'Belt Tracked' cell is empty. */
  | 'belt_not_tracked'
  /** REFUSED: the tracked-state lookup failed, so we cannot prove the belt is tracked. */
  | 'gate_unavailable'

export interface GateDecision {
  allowed: boolean
  /** Machine-readable. Stable — clients may branch on it. */
  code: GateCode
  /** Operator-readable. Safe to render verbatim in the field UI. */
  message: string
  /** The field that produced this decision (echoed as sent). */
  field: string
}

/**
 * THE DECISION. Pure.
 *
 * Fails CLOSED on a lookup error and OPEN on an unjudgeable device, and those
 * are deliberately different:
 *
 *  - A lookup ERROR means the SQLite read threw. We cannot prove the belt is
 *    tracked, and the cost of refusing is that seven fields stop working while
 *    the DB is broken — every pre-gate write, including the Valid_HP that
 *    keeps the keypad alive, still goes through. Refusing is the safe
 *    direction and it is cheap.
 *
 *  - An UNJUDGEABLE device (no L2 row on a VFD/APF sheet) is not evidence of
 *    anything. It is the same class as a sheet with no 'Belt Tracked' column:
 *    this deployment has no belt-tracking data for that device, so there is no
 *    gate to enforce. Refusing here would brick commissioning on any device
 *    the L2 import has not covered. It is logged by the caller.
 */
export function judgeWrite(field: string, state: BeltTrackedState): GateDecision {
  const f = norm(field)

  if (ALWAYS_ALLOWED_SET.has(f)) {
    return {
      allowed: true,
      code: 'retraction_field',
      field,
      message: `${field} only clears state — never blocked.`,
    }
  }

  if (!POST_GATE_SET.has(f)) {
    return {
      allowed: true,
      code: 'pre_gate_field',
      field,
      message: `${field} does not depend on belt tracking.`,
    }
  }

  if (!state.resolved) {
    // `'error' in state` rather than `state.error`: the server tsconfig does not
    // narrow the discriminated union on the boolean `resolved` discriminant, so a
    // bare property access fails to compile there even though it is safe here.
    const err = 'error' in state ? state.error : undefined
    if (err) {
      return {
        allowed: false,
        code: 'gate_unavailable',
        field,
        message:
          `Cannot check whether this belt is tracked (${err}), so ${field} was not sent ` +
          'to the PLC. Pull the latest data or restart the tool, then try again.',
      }
    }
    return {
      allowed: true,
      code: 'device_not_in_l2',
      field,
      message: 'No functional-validation row for this device — no belt-tracking gate applies.',
    }
  }

  if (!state.hasColumn) {
    return {
      allowed: true,
      code: 'no_belt_tracking_column',
      field,
      message: `This sheet has no "${BELT_TRACKED_COLUMN_NAME}" column — no belt-tracking gate applies.`,
    }
  }

  if (!state.tracked) {
    return {
      allowed: false,
      code: 'belt_not_tracked',
      field,
      message:
        `This belt is not marked "${BELT_TRACKED_COLUMN_NAME}", so ${field} was NOT sent to the PLC. ` +
        'The mechanical team is still tracking this belt and needs the keypad — sending this ' +
        'would take belt direction away from them. Wait for them to mark it tracked on the ' +
        'cloud belt-tracking page; it syncs back here automatically.',
    }
  }

  return {
    allowed: true,
    code: 'belt_tracked',
    field,
    message: `Belt is marked "${BELT_TRACKED_COLUMN_NAME}".`,
  }
}

/**
 * Judge a whole batch. Returns the FIRST refusal, or null when every write is
 * permitted.
 *
 * All-or-nothing on purpose: write-tags-batch exists so a pair of CMD bits
 * lands in the same controller scan (Override_RVS + RVS, Reverse_Polarity +
 * Normal_Polarity). Half a pair is not a safer outcome than none of it.
 */
export function judgeBatch(
  fields: readonly string[],
  state: BeltTrackedState,
): GateDecision | null {
  for (const field of fields) {
    const d = judgeWrite(field, state)
    if (!d.allowed) return d
  }
  return null
}
