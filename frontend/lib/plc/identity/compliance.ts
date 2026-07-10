/**
 * Pure firmware-compliance evaluation.
 *
 * Compares a device's live CIP Identity against the cloud-curated approved-
 * firmware baseline. The baseline is keyed on (vendorId, productCode) and
 * expresses a MINIMUM supported revision — live >= min ⇒ compliant. Newer is
 * always acceptable; only out-of-date firmware flags.
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
  /** Minimum approved firmware — live revision must be >= this. */
  minRevMajor: number
  minRevMinor: number
}

/**
 * Per-device compliance outcome:
 *   compliant     — baseline found and live >= min
 *   non_compliant — baseline found and live < min
 *   no_baseline   — device read but no matching baseline (unknown hardware)
 *   unreachable   — device expected/discovered but Identity read failed
 */
export type ComplianceVerdict = 'compliant' | 'non_compliant' | 'no_baseline' | 'unreachable'

/**
 * Compare revision A to revision B. Negative if A < B, 0 if equal, positive if
 * A > B. Major dominates minor (an older major always loses, regardless of
 * minor).
 */
export function compareRevision(
  aMajor: number, aMinor: number, bMajor: number, bMinor: number,
): number {
  if (aMajor !== bMajor) return aMajor - bMajor
  return aMinor - bMinor
}

/**
 * Find the baseline entry for a device by productCode, optionally narrowed by
 * vendorId. The diagnostics UDT reports only productCode (no vendor), so pass
 * vendorId = null to match on productCode alone; the @raw controller read has a
 * real vendorId and matches exactly.
 */
export function findBaseline(
  baselines: readonly FirmwareBaseline[], vendorId: number | null, productCode: number,
): FirmwareBaseline | undefined {
  return baselines.find((b) =>
    b.productCode === productCode && (vendorId == null || b.vendorId === vendorId))
}

/**
 * Decide a device's compliance verdict from its (possibly null) live Identity
 * and its (possibly missing) baseline entry. A null identity means the read
 * failed → unreachable; a missing baseline → no_baseline (surfaced, never
 * silently passed).
 */
export function evaluateCompliance(
  identity: DeviceIdentity | null,
  baseline: FirmwareBaseline | undefined,
): ComplianceVerdict {
  if (!identity) return 'unreachable'
  if (!baseline) return 'no_baseline'
  return compareRevision(identity.revMajor, identity.revMinor, baseline.minRevMajor, baseline.minRevMinor) >= 0
    ? 'compliant'
    : 'non_compliant'
}

/**
 * Display-level refinement of a compliant verdict: 'mismatch' when the live
 * revision differs from the approved revision even though it satisfies the
 * minimum (i.e. the device runs NEWER firmware than the project was engineered
 * against). Gating semantics are untouched — a mismatch still counts as
 * compliant everywhere decisions are made (guided step, filters on
 * non_compliant); this exists so a deviation from the approved revision is
 * SHOWN, never silently absorbed into a green badge.
 *
 * Takes the pre-formatted "major.minor" strings the scan results already carry
 * so UI callers need no re-parse; string equality is exact because both sides
 * are formatted identically.
 */
export type DisplayVerdict = ComplianceVerdict | 'mismatch'

export function displayVerdict(
  verdict: ComplianceVerdict,
  liveRevision: string | null,
  approvedMin: string | null,
): DisplayVerdict {
  if (verdict !== 'compliant') return verdict
  if (liveRevision == null || approvedMin == null) return verdict
  return liveRevision === approvedMin ? 'compliant' : 'mismatch'
}
