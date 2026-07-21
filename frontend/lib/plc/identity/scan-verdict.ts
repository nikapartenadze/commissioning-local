/**
 * Pure guided-step scan verdict.
 *
 * Extracted from the inline computation in guided-task-runner.tsx so the
 * honest-failure rule is testable outside a React component.
 *
 * Side-effect-free; unit-tested in __tests__/firmware-compliance.test.ts.
 */

import type { ComplianceVerdict } from './compliance'

export interface ScanSummary {
  verdict: 'pass' | 'fail' | 'unknown'
  nonCompliant: number
  differs: number
  /** Devices that could not be judged — no_baseline or unreachable. */
  unverified: number
  deviceCount: number
}

/**
 * Summarise a scan into a guided-step verdict.
 *
 * HONEST-FAILURE RULE: pass requires ≥1 device read AND every read device
 * verified. All-no_baseline / all-unreachable reports `unknown`, never a pass —
 * "ALL COMPLIANT" with zero verified devices was a real bug (fixed 2026-07-08).
 *
 * `differs` (newer than approved) counts as verified and PASSES: it is
 * surfaced, but must not fail a gate that passes today.
 */
export function summariseScan(
  devices: ReadonlyArray<{ verdict: ComplianceVerdict }>,
): ScanSummary {
  const nonCompliant = devices.filter((d) => d.verdict === 'non_compliant').length
  const differs = devices.filter((d) => d.verdict === 'differs').length
  const unverified = devices.filter(
    (d) => d.verdict === 'no_baseline' || d.verdict === 'unreachable',
  ).length

  const verdict =
    nonCompliant > 0 ? 'fail'
    : unverified > 0 || devices.length === 0 ? 'unknown'
    : 'pass'

  return { verdict, nonCompliant, differs, unverified, deviceCount: devices.length }
}
