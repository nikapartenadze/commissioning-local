/**
 * Per-port health predicates for the Network diagnostics page.
 *
 * These are the "catch bad connections/terminations" rules: given one
 * `PortStat` (a decoded CIP Ethernet Link Object snapshot), decide whether the
 * port is healthy, softly warning, or hard-broken. They are deliberately pure
 * and free of React/component types so they can be unit-tested directly — see
 * `__tests__/port-health.test.ts`.
 *
 * Severity model:
 *   RED   (hard error) — physical-layer / frame-level breakage. Something is
 *                        actually wrong on the wire or in the module.
 *   ORANGE (soft warn)  — the port works, but a configuration or congestion
 *                        signal is present that an operator should look at.
 *
 * Ground truth for the flag bits comes from the customer's L5X ladder, which
 * decodes `Link_Status_Raw` (CIP Class 0xF6 Attr 2, Interface Flags) as:
 *   bit 0 -> Link_Up
 *   bit 1 -> Full_Duplex
 *   bit 5 -> Reset_Required   (link parameter change pending a module reset)
 *   bit 6 -> Hardware_Fault
 * `speedMbps` is CIP Class 0xF6 Attr 1 and IS populated by current PLC
 * programs; older programs leave it 0.
 */

import type { PortStat } from './types'

/**
 * Speeds at or above this are considered normal for industrial Ethernet.
 * 100 Mbps is the NATIVE speed of most parts on these rings (VFDs, FIOMs,
 * 1756-EN2T modules), so flagging it would fire on nearly every port on site.
 * Only a link that negotiated down to 10 Mbps indicates a cable/negotiation
 * failure.
 */
export const NOMINAL_SPEED_MBPS = 100

// ─── Counter-based predicates (unchanged behaviour) ─────────────────────

/** Any non-zero Media Counter (Class 0xF6 Attr 5) — physical-layer faults. */
export function hasMediaErrors(p: PortStat): boolean {
  return (
    p.alignErr > 0 || p.fcsErr > 0 || p.singleColl > 0 || p.multiColl > 0 ||
    p.sqeErr > 0 || p.deferredTx > 0 || p.lateColl > 0 || p.excessColl > 0 ||
    p.macTxErr > 0 || p.carrierSense > 0 || p.frameTooLong > 0 || p.macRxErr > 0
  )
}

/** Any non-zero Interface Counter error OR discard (Class 0xF6 Attr 4). */
export function hasInterfaceErrors(p: PortStat): boolean {
  return p.errorsIn > 0 || p.errorsOut > 0 || p.discardsIn > 0 || p.discardsOut > 0
}

/**
 * Link is down but the port has moved traffic — i.e. it used to work and has
 * since dropped. A port that never linked and never passed a byte is simply
 * unused, not broken.
 */
export function isActivelyDown(p: PortStat): boolean {
  if (p.linkUp) return false
  return p.octetsIn > 0 || p.octetsOut > 0
}

// ─── Link-parameter predicates ──────────────────────────────────────────

/**
 * Half duplex on a live link (bit 1 clear while bit 0 set).
 *
 * Every switch port on these rings is full-duplex capable, so a half-duplex
 * link means auto-negotiation failed — classically because of a bad
 * termination, a damaged pair, or a hard-coded speed/duplex on one end. It is
 * the textbook cause of late collisions, so it is treated as a HARD error.
 *
 * A down port has no meaningful duplex, so this is false when `linkUp` is false.
 */
export function isDuplexMismatch(p: PortStat): boolean {
  return p.linkUp && !p.fullDuplex
}

/**
 * Live link that negotiated below the nominal 100 Mbps — in practice 10 Mbps.
 *
 * Deliberately conservative to avoid mass false positives:
 *   - 100 is NORMAL (most industrial parts are 100 Mbps) -> never flagged.
 *   - 1000 is above nominal -> never flagged.
 *   - 0 means "this PLC program does not MSG-read Attr 1", NOT "0 Mbps"
 *     -> never flagged.
 *   - a down link has no speed to judge -> never flagged.
 * Only 10 Mbps on an up link survives all of that, and that genuinely means a
 * negotiation or cabling failure.
 */
export function isDegradedSpeed(p: PortStat): boolean {
  return p.linkUp && p.speedMbps > 0 && p.speedMbps < NOMINAL_SPEED_MBPS
}

/**
 * bit 5 — a link parameter change is pending an Identity Object reset.
 *
 * SOFT warning only: this is a configuration state, not wire breakage. The
 * link is carrying traffic; someone just changed a setting that will not take
 * effect until the module is reset.
 */
export function needsReset(p: PortStat): boolean {
  return p.resetRequired
}

// ─── Roll-up ────────────────────────────────────────────────────────────

/**
 * Physical-layer / frame-level problems. These are real network breakage, not
 * "things are a bit slow" — should always render RED.
 */
export function hasHardError(p: PortStat): boolean {
  return (
    p.hardwareFault ||
    hasMediaErrors(p) ||
    p.errorsIn > 0 ||
    p.errorsOut > 0 ||
    isDuplexMismatch(p) ||
    isDegradedSpeed(p)
  )
}

/**
 * Discards without any hard errors → soft warning. The PLC chose to drop these
 * packets (e.g. congestion); nothing is broken at the wire level.
 *
 * Note this REQUIRES discards to be present — use `hasSoftWarning` for the
 * full orange test, which also covers a reset-required-only port.
 */
export function hasOnlyDiscards(p: PortStat): boolean {
  return (p.discardsIn > 0 || p.discardsOut > 0) && !hasHardError(p)
}

/**
 * Any ORANGE-worthy signal on a port that is otherwise healthy: discards, or a
 * pending module reset. Ports that are actively down or hard-errored are RED
 * and are never reported as soft.
 */
export function hasSoftWarning(p: PortStat): boolean {
  if (isActivelyDown(p) || hasHardError(p)) return false
  return hasOnlyDiscards(p) || needsReset(p)
}

export type PortSeverity = 'ok' | 'warn' | 'error'

/** Single source of truth for a port's colour: RED > ORANGE > OK. */
export function portSeverity(p: PortStat): PortSeverity {
  if (isActivelyDown(p) || hasHardError(p)) return 'error'
  if (hasSoftWarning(p)) return 'warn'
  return 'ok'
}
