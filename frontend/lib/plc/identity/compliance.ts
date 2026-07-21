/**
 * Pure firmware-compliance evaluation.
 *
 * Compares a device's live CIP Identity against the cloud-curated approved-
 * firmware baseline. The baseline is scoped per MCM (subsystemId), because
 * each MCM's controller program specifies its own engineered revision per
 * module — a fleet-wide MINIMUM would take the lowest across every MCM and
 * certify the wrong firmware. Measured on CDW5: Armor PowerFlex (productCode
 * 2) is approved 2.1 on ten MCMs but 2.6 on three others (MCM11/14/15).
 * `findBaseline` therefore matches MCM-first, fleet-wide (subsystemId = null)
 * as fallback, and `evaluateCompliance` judges by EXACT revision match rather
 * than a floor — a device running newer firmware than the project was
 * engineered against must be visible as `differs`, not silently absorbed
 * into a green "compliant" badge.
 *
 * Mirrors commissioning-cloud/lib/firmware-compliance.ts — the two cannot
 * share code (separate repos); keep them in step by hand.
 *
 * Side-effect-free; unit-tested in __tests__/firmware-compliance.test.ts.
 */

import type { DeviceIdentity } from './identity-parse'

/** One approved-firmware entry, synced down from the cloud baseline. */
export interface FirmwareBaseline {
  vendorId: number
  productCode: number
  /** Friendly model name for display (the device also reports its own). */
  modelName?: string
  /** The APPROVED revision for this scope — not a floor. */
  minRevMajor: number
  minRevMinor: number
  /** Owning MCM, or null for the fleet-wide default. */
  subsystemId: number | null
}

/**
 * Per-device compliance outcome:
 *   compliant     — baseline found and live === approved, exactly
 *   differs       — baseline found and live is NEWER than approved (surfaced, not a failure)
 *   non_compliant — baseline found and live is older than / a different revision from approved
 *   no_baseline   — device read but no matching baseline at any scope (unknown hardware)
 *   unreachable   — device expected/discovered but Identity read failed
 */
export type ComplianceVerdict = 'compliant' | 'differs' | 'non_compliant' | 'no_baseline' | 'unreachable'

/**
 * Compare revision A to revision B. Negative if A < B, 0 if equal, positive if
 * A > B. Major dominates minor (an older major always loses, regardless of
 * minor). Both fields are integers — NEVER parse a revision as a float:
 * minors 1 vs 10 would collapse to equal ("36.1" === parseFloat("36.10")) and
 * 2 vs 11 would reverse order (0.2 > 0.11).
 */
export function compareRevision(
  aMajor: number, aMinor: number, bMajor: number, bMinor: number,
): number {
  if (aMajor !== bMajor) return aMajor - bMajor
  return aMinor - bMinor
}

/**
 * Resolve the baseline for a device, MCM-scoped first then fleet-wide.
 *
 * `vendorId` is optional (pass null) because the network-diagnostics UDT
 * reports only productCode, no vendor — match on productCode alone in that
 * case; the @raw controller read has a real vendorId and matches exactly.
 *
 * `fleetDefault` tells the caller the verdict came from the fallback, not
 * from a row curated for this MCM — a verdict must never imply more
 * authority than it has.
 */
export function findBaseline(
  baselines: readonly FirmwareBaseline[],
  vendorId: number | null,
  productCode: number,
  subsystemId: number | null,
): { baseline: FirmwareBaseline; fleetDefault: boolean } | undefined {
  const matches = (b: FirmwareBaseline) =>
    b.productCode === productCode && (vendorId == null || b.vendorId === vendorId)

  if (subsystemId != null) {
    const scoped = baselines.find((b) => b.subsystemId === subsystemId && matches(b))
    if (scoped) return { baseline: scoped, fleetDefault: false }
  }
  const fleet = baselines.find((b) => b.subsystemId == null && matches(b))
  return fleet ? { baseline: fleet, fleetDefault: true } : undefined
}

/**
 * Decide a device's compliance verdict from its (possibly null) live Identity
 * and its (possibly missing) baseline entry. A null identity means the read
 * failed → unreachable; a missing baseline → no_baseline (surfaced, never
 * silently passed). Otherwise exact match: equal → compliant, live newer →
 * differs, live older or a different revision → non_compliant.
 */
export function evaluateCompliance(
  identity: DeviceIdentity | null,
  baseline: FirmwareBaseline | undefined,
): ComplianceVerdict {
  if (!identity) return 'unreachable'
  if (!baseline) return 'no_baseline'
  const cmp = compareRevision(identity.revMajor, identity.revMinor, baseline.minRevMajor, baseline.minRevMinor)
  if (cmp === 0) return 'compliant'
  return cmp > 0 ? 'differs' : 'non_compliant'
}
