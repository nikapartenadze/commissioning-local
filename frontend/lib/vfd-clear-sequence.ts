/**
 * PLC write sequence for the manual "Clear Test" reset
 * (app/api/vfd-commissioning/clear/route.ts).
 *
 * WHY THIS EXISTS AS ITS OWN MODULE: the route imports db-sqlite and prepares
 * statements at module load, so its logic cannot be unit-tested. Everything
 * here is pure or injectable — no DB, no DLL, no controller.
 *
 * ── THE BUG THIS FIXES ────────────────────────────────────────────────────
 * The route used to pulse, in order: Invalidate_Map, Invalidate_HP,
 * Invalidate_Direction, then Normal_Polarity=1 / Reverse_Polarity=0 — and it
 * NEVER sent Invalidate_Tracking_Finished at all. On the MCM path all five went
 * out as ONE batch, so the controller could see them in a single scan.
 *
 * That combination permanently strands belts:
 *
 *   Invalidate_HP drops Valid_HP. The WHOLE of AOI rung 3 sits under
 *   XIC(Valid_HP). So from that scan on, rung 3 is dead — and rung 3 is the
 *   only rung that can ever clear Tracking_Finished. The latch was never
 *   invalidated in the first place, and now it CAN'T be. Clear Test has been
 *   manufacturing permanently-latched belts, with the keypad locked out of
 *   polarity for good.
 *
 * ── GROUND TRUTH ─────────────────────────────────────────────────────────
 * Read directly out of AOI_IOCT_BELT_TRACKING_AOI222.L5X and ..._AOI.L5X (the
 * older rev). Do NOT re-derive this from code comments — several in this repo
 * are wrong, including one this module replaced that cited a "rung 13" in a
 * routine whose rungs are 0-10.
 *
 *   rung 1: [ ... XIC(CMD.Invalidate_Map) OTU(Valid_Map),
 *             XIC(Valid_Map) XIC(CMD.Valid_HP) ONS OTL(Valid_HP),
 *             XIC(CMD.Invalidate_HP) OTU(Valid_HP) ]        ← NOT gated
 *   rung 3: XIC(Valid_HP)[ XIC(CMD.Tracking_Finished) ONS OTL(Tracking_Finished),
 *             XIC(CMD.Invalidate_Tracking_Finished) OTU(Tracking_Finished),
 *             XIO(Tracking_Finished)[ XIC(Flip_Polarity) OTL(Reverse_Polarity),
 *                                     XIO(Flip_Polarity) OTU(Reverse_Polarity) ],
 *             XIC(Tracking_Finished)[ XIC(CMD.Reverse_Polarity) ONS OTL(Reverse_Polarity),
 *                                     XIC(CMD.Normal_Polarity) OTU(Reverse_Polarity) ] ]
 *   rung 5: ... XIC(Valid_HP) XIC(SafeTorqueEnabled)[...] OTE(Track_Belt),
 *           XIC(Track_Belt) XIC(Track_Start_TMR.DN) OTE(Drive_Outputs.Start),
 *           [ XIC(Valid_HP) XIO(Track_Belt) XIO(Jogging),
 *             XIC(KeypadHandMode) ] OTE(Drive_Outputs.Stop)
 *   rung 6: [ XIC(Tracking_Finished) XIC(CMD.Valid_Direction) ONS OTL(Valid_Direction),
 *             XIC(CMD.Invalidate_Direction) OTU(Valid_Direction), ... ]  ← NOT gated
 *   rung 7: [ XIO(Reverse_Polarity) OTE(DirectionCmd_0),
 *             XIC(Reverse_Polarity) OTE(DirectionCmd_1) ]   ← UNCONDITIONAL
 *   rung 8: FLL(0, CTRL.CMD, 1)                             ← every CMD is a pulse
 *   rung 9: XIC(Track_Belt) OTE(STS.Belt_Tracking_ON)   [older rev: OTE(STS.Track_Belt)]
 *           MOVE(Drive_Outputs.CommandedVelocity, STS.RVS)
 *
 * Consequences that shape the code below:
 *
 *  1. ORDER IS THE FIX. Invalidate_HP must go LAST, because it kills the rung
 *     that clears the tracking latch. Invalidate_Map likewise feeds Valid_HP's
 *     OTL seal on rung 1, so it keeps HP company at the end.
 *
 *  2. ONE FIELD PER ROUND-TRIP, never a batch. rung 8 zeroes all of CTRL.CMD
 *     every scan, so each CMD bit is a self-clearing one-scan pulse. Worse,
 *     within rung 3 the branches evaluate top-to-bottom: branch 2's
 *     OTU(Tracking_Finished) runs BEFORE branch 4 tests XIC(Tracking_Finished).
 *     So Normal_Polarity and Invalidate_Tracking_Finished arriving in the SAME
 *     scan means Normal_Polarity is silently lost. Separate sequential writes
 *     land in separate scans, which is what the sequence depends on.
 *
 *  3. Normal_Polarity FIRST. It is only honoured on rung 3's
 *     XIC(Tracking_Finished) branch — i.e. only WHILE THE LATCH IS STILL SET.
 *     Sent after the invalidate it is a dead write.
 *
 *  4. CMD.Reverse_Polarity = 0 IS NOT SENT. A CMD input at 0 drives nothing
 *     (every rung tests it with XIC), and rung 8 zeroes it every scan anyway.
 *     The old route's "both writes are required" comment was simply wrong.
 *
 *  5. Invalidate_Direction is its own pulse on rung 6 — Valid_Direction does
 *     NOT fall out of Tracking_Finished dropping.
 *
 *  6. `Stop_Belt_Tracking` is a DEAD TAG: declared in
 *     UDT_CTRL_IOCT_BELT_TRACKING_CMD, used in ZERO of the 11 rungs. Never
 *     written here.
 *
 * ── SAFETY: WHY THIS REFUSES TO RUN ON A MOVING BELT ─────────────────────
 * Dropping Tracking_Finished hands Reverse_Polarity straight back to the
 * keypad (rung 3 branch 3, XIO(Tracking_Finished)), and rung 7 maps
 * Reverse_Polarity onto DirectionCmd UNCONDITIONALLY. On a running belt with
 * Start still asserted, that is a DIRECTION REVERSAL.
 *
 * Invalidate_HP is independently dangerous under motion: rung 5 gates
 * OTE(Track_Belt) on Valid_HP, so dropping it de-asserts Drive_Outputs.Start —
 * while the Stop branch of the same rung is ALSO gated on Valid_HP and so does
 * NOT assert. The drive is left coasting with no stop command.
 *
 * Therefore NOTHING is written unless the drive is provably stopped, and
 * "provably" is strict: a missing STS member or an unreadable value ABORTS.
 * We never guess in the permissive direction.
 */
import {
  RETRACTION_WRITE_ORDER,
  BELT_TRACKING_ON_MEMBERS,
  RVS_STOPPED_EPSILON,
  type RetractionSts,
} from '@/lib/vfd-validation-writer'

export { BELT_TRACKING_ON_MEMBERS, RVS_STOPPED_EPSILON }
export type { RetractionSts }

/**
 * The full Clear-Test write order.
 *
 * Built from the writer's RETRACTION_WRITE_ORDER rather than re-listed, so the
 * safety-critical prefix physically cannot drift away from
 * vfd-validation-writer's untrack retraction:
 *
 *   1. Normal_Polarity              — while the latch is still set (rung 3 br.4)
 *   2. Invalidate_Direction         — rung 6, its own pulse
 *   3. Invalidate_Tracking_Finished — rung 3, the latch
 *   4. Invalidate_Map               — rung 1
 *   5. Invalidate_HP                — rung 1, LAST: it kills rung 3's gate
 */
export const CLEAR_WRITE_ORDER: readonly string[] = [
  ...RETRACTION_WRITE_ORDER,
  'Invalidate_Map',
  'Invalidate_HP',
]

/** The rung-3-gated prefix — dead writes whenever STS.Valid_HP is already 0. */
export const LATCH_WRITE_FIELDS: readonly string[] = RETRACTION_WRITE_ORDER

/** The rung-1 writes, which work regardless of Valid_HP. */
export const VALIDITY_WRITE_FIELDS: readonly string[] = ['Invalidate_Map', 'Invalidate_HP']

export type ClearPlcAction =
  /** Everything is writable: full CLEAR_WRITE_ORDER. */
  | 'proceed'
  /** Valid_HP is already 0 — rung 3 is dead, so only the rung-1 writes are real. */
  | 'proceed-without-latch-writes'
  /** Not provably stopped, or blind. Write NOTHING. */
  | 'abort'

export interface ClearPlcPlan {
  action: ClearPlcAction
  reason: string
}

/**
 * PURE decision: may we run the Clear-Test PLC sequence right now?
 *
 * NOTE the check order differs deliberately from the writer's planRetraction():
 * that one tests Valid_HP first (it only ever wants the rung-3 writes, so a
 * dead rung 3 means there is nothing to do). Clear Test ALSO issues rung-1
 * writes, which are dangerous under motion in their own right (rung 5), so
 * stopped-ness is proven FIRST and gates everything.
 *
 * STS.RVS is a MOVE of Drive_Outputs.CommandedVelocity (rung 9) — COMMANDED
 * velocity, not measured. It reads 0 on a belt that is still physically
 * coasting. So this proves "not commanded to move", not "mechanically at
 * rest". That is the correct guard for what we are protecting against (a
 * direction reversal under an asserted Start), but it is NOT a personnel
 * safety interlock and must never be presented as one.
 */
export function planClearPlcSequence(sts: RetractionSts): ClearPlcPlan {
  // 1. Prove the drive is not commanded to move — BEFORE anything else.
  if (sts.beltTrackingOn == null) {
    return {
      action: 'abort',
      reason:
        'neither STS.Belt_Tracking_ON nor STS.Track_Belt could be read — cannot prove the ' +
        'drive is stopped, and clearing a moving belt reverses it (AOI rung 7 is unconditional)',
    }
  }
  if (sts.beltTrackingOn !== 0) {
    return {
      action: 'abort',
      reason:
        'belt tracking is still RUNNING — stop the belt before clearing. Dropping ' +
        'Tracking_Finished hands polarity back to the keypad and AOI rung 7 drives DirectionCmd ' +
        'unconditionally, so this would reverse a moving belt with Start asserted',
    }
  }
  if (sts.rvs == null) {
    return { action: 'abort', reason: 'STS.RVS unreadable — cannot prove commanded velocity is zero' }
  }
  if (Math.abs(sts.rvs) >= RVS_STOPPED_EPSILON) {
    return { action: 'abort', reason: `STS.RVS=${sts.rvs} — drive is still commanded to move` }
  }

  // 2. Drive is stopped. Now: is rung 3 actually live?
  if (sts.validHp == null) {
    return {
      action: 'abort',
      reason: 'STS.Valid_HP unreadable — cannot tell whether the tracking-latch rung is live',
    }
  }
  if (sts.validHp === 0) {
    return {
      action: 'proceed-without-latch-writes',
      reason:
        'STS.Valid_HP=0 — the whole of AOI rung 3 is gated on Valid_HP, so Normal_Polarity / ' +
        'Invalidate_Tracking_Finished would silently do nothing. If Tracking_Finished is still ' +
        'latched it CANNOT be cleared until Valid_HP is re-established by re-running the HP check',
    }
  }
  return { action: 'proceed', reason: 'drive stopped (tracking off, RVS~0) and Valid_HP=1' }
}

/**
 * The typed reads needed to build a RetractionSts for `deviceName`, in the
 * order `resolveStsFromTypedReads` expects them back. Both AOI revisions'
 * belt-tracking member names are requested; whichever the controller does not
 * have simply comes back unsuccessful, which must NOT throw.
 */
export function clearStsReads(deviceName: string): Array<{ name: string; dataType: 'BOOL' | 'REAL' }> {
  const base = `CBT_${deviceName}.CTRL.STS.`
  return [
    { name: `${base}Valid_HP`, dataType: 'BOOL' },
    ...BELT_TRACKING_ON_MEMBERS.map(m => ({ name: `${base}${m}`, dataType: 'BOOL' as const })),
    { name: `${base}RVS`, dataType: 'REAL' },
  ]
}

/**
 * PURE: fold a typed-read batch (as returned by readTypedTagsForMcm) into a
 * RetractionSts. Anything unreadable becomes null, which planClearPlcSequence
 * treats as "unprovable" and therefore aborts on.
 */
export function resolveStsFromTypedReads(
  results: Array<{ success: boolean; value?: unknown; error?: string }> | undefined,
): RetractionSts {
  const rows = results ?? []
  const bool = (i: number): number | null => {
    const r = rows[i]
    if (!r?.success) return null
    return r.value === true || r.value === 1 ? 1 : 0
  }

  const validHp = bool(0)

  let beltTrackingOn: number | null = null
  for (let i = 0; i < BELT_TRACKING_ON_MEMBERS.length; i++) {
    const v = bool(1 + i)
    if (v !== null) { beltTrackingOn = v; break }
  }

  const rvsRow = rows[1 + BELT_TRACKING_ON_MEMBERS.length]
  const rvs = rvsRow?.success && typeof rvsRow.value === 'number' && Number.isFinite(rvsRow.value)
    ? rvsRow.value
    : null

  return { validHp, beltTrackingOn, rvs }
}

export interface ClearWriteOutcome {
  field: string
  ok: boolean
  error?: string
  /** Set when the write was deliberately not issued. */
  skipped?: boolean
}

export interface ClearPlcResult {
  action: ClearPlcAction
  reason: string
  writes: ClearWriteOutcome[]
  /** True when the tracking latch was actually invalidated on the controller. */
  latchCleared: boolean
}

/**
 * Run the Clear-Test sequence against ONE device, given a resolved STS
 * snapshot and a single-field writer.
 *
 * `writeOne` MUST issue exactly one CMD bit per call and resolve only once the
 * controller has taken it — see consequence 2 above: batching these collapses
 * them into one scan and silently loses Normal_Polarity, and (in the original
 * bug) let Invalidate_HP kill rung 3 in the same scan as the invalidate that
 * needed it.
 *
 * Failure handling is asymmetric on purpose:
 *   - A failure anywhere in the rung-3 triad ABORTS the rest, INCLUDING
 *     Invalidate_Map/HP. Sending Invalidate_HP after a failed
 *     Invalidate_Tracking_Finished is exactly how a belt gets stranded: the
 *     latch is still set and rung 3 is now dead.
 *   - A failure on Invalidate_Map does not stop Invalidate_HP; they are
 *     independent rung-1 branches and the latch is already safely cleared.
 */
export async function runClearPlcSequence(
  sts: RetractionSts,
  writeOne: (field: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<ClearPlcResult> {
  const plan = planClearPlcSequence(sts)
  if (plan.action === 'abort') {
    return { action: 'abort', reason: plan.reason, writes: [], latchCleared: false }
  }

  const writes: ClearWriteOutcome[] = []
  let latchCleared = false

  if (plan.action === 'proceed') {
    for (const field of LATCH_WRITE_FIELDS) {
      const r = await writeOne(field)
      writes.push({ field, ok: r.ok, error: r.error })
      if (!r.ok) {
        // ABORT — do not touch Valid_Map/Valid_HP with the latch still set.
        for (const rest of CLEAR_WRITE_ORDER.slice(writes.length)) {
          writes.push({
            field: rest,
            ok: false,
            skipped: true,
            error:
              `not issued: CMD.${field} failed, so the tracking latch may still be set — ` +
              'sending Invalidate_HP now would kill AOI rung 3 and strand it permanently',
          })
        }
        return { action: plan.action, reason: plan.reason, writes, latchCleared: false }
      }
    }
    latchCleared = true
  } else {
    // Valid_HP=0: rung 3 is dead. Report the triad as skipped rather than
    // issuing writes that would return ok:true while doing nothing.
    for (const field of LATCH_WRITE_FIELDS) {
      writes.push({ field, ok: false, skipped: true, error: plan.reason })
    }
  }

  for (const field of VALIDITY_WRITE_FIELDS) {
    const r = await writeOne(field)
    writes.push({ field, ok: r.ok, error: r.error })
  }

  return { action: plan.action, reason: plan.reason, writes, latchCleared }
}
