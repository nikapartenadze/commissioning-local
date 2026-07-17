/**
 * Test: per-subsystem network-failure isolation in the IO push drain.
 *
 * Regression for the multi-MCM starvation bug (central-server instances):
 * the drain read PendingSyncs GLOBALLY (ORDER BY CreatedAt ASC LIMIT 50) and
 * used ONE batch-wide network-failure counter with a hard `break` after 3
 * network-classified failures (offline / 401 / 403 / 429 / 5xx). A single
 * permanently-misconfigured MCM (revoked key / project-key mismatch) whose
 * rows are the OLDEST by CreatedAt parks itself at the FRONT of the window and
 * trips the 3-failure break every 10s cycle — so newer, perfectly-healthy
 * rows from OTHER MCMs that sort after it in the same LIMIT-50 window are never
 * attempted, indefinitely. If that box is lost before an operator fixes the
 * unrelated MCM, the healthy MCMs' unsynced results are gone for good.
 *
 * Rule: a network-level failure defers ONLY its own subsystem for the rest of
 * the cycle; healthy subsystems must still be attempted. A deferred subsystem's
 * remaining rows are skipped WITHOUT a network call (preserving the original
 * "don't hammer a down cloud with 15s timeouts" efficiency).
 */
import { describe, it, expect } from 'vitest'
import { SubsystemNetworkDeferral } from '@/lib/cloud/subsystem-network-deferral'

const NETWORK_FAILURE_BATCH_TOLERANCE = 3

interface Row { id: number; subsystemId: number | null }
type Attempt = { network: boolean }

/**
 * Faithful model of the drain loop's scheduling decision, driven by the
 * helper. `classify(row)` scripts what the cloud does for each attempted row.
 * Returns the ids that were ACTUALLY attempted (a network call was made).
 */
function drain(rows: Row[], classify: (r: Row) => Attempt): number[] {
  const deferral = new SubsystemNetworkDeferral(NETWORK_FAILURE_BATCH_TOLERANCE)
  const attempted: number[] = []
  for (const row of rows) {
    if (deferral.isDeferred(row.subsystemId)) continue // skipped, no network call
    attempted.push(row.id)
    const r = classify(row)
    if (r.network) deferral.recordNetworkFailure(row.subsystemId)
  }
  return attempted
}

describe('SubsystemNetworkDeferral — multi-MCM push isolation', () => {
  it('a broken MCM sorting FIRST does not starve healthy MCMs behind it', () => {
    // MCM11 (subsystem 79) is misconfigured — every push 403s (network-level).
    // Its rows are the oldest, so they lead the CreatedAt-ASC window.
    const rows: Row[] = [
      { id: 1, subsystemId: 79 }, // MCM11 broken (oldest)
      { id: 2, subsystemId: 79 },
      { id: 3, subsystemId: 79 },
      { id: 4, subsystemId: 79 },
      { id: 5, subsystemId: 38 }, // MCM02 healthy
      { id: 6, subsystemId: 38 },
      { id: 7, subsystemId: 55 }, // MCM05 healthy
    ]
    const attempted = drain(rows, (r) => ({ network: r.subsystemId === 79 }))

    // Healthy MCMs MUST be attempted despite the broken MCM sorting first.
    expect(attempted).toContain(5)
    expect(attempted).toContain(6)
    expect(attempted).toContain(7)
    // The broken MCM is attempted only up to the tolerance, then its remaining
    // rows are skipped WITHOUT a network call.
    expect(attempted).toEqual([1, 2, 3, 5, 6, 7])
  })

  it('a fully-down cloud (single MCM) still stops after the tolerance — no wasted attempts', () => {
    const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, subsystemId: 38 }))
    const attempted = drain(rows, () => ({ network: true }))
    // Only 3 attempts made; the other 17 rows skipped for free.
    expect(attempted).toEqual([1, 2, 3])
  })

  it('a subsystem that succeeds is never deferred', () => {
    const deferral = new SubsystemNetworkDeferral(NETWORK_FAILURE_BATCH_TOLERANCE)
    // Two failures then success then more traffic — must stay attemptable.
    deferral.recordNetworkFailure(38)
    deferral.recordNetworkFailure(38)
    expect(deferral.isDeferred(38)).toBe(false)
  })

  it('null (unknown) subsystem rows are bucketed together, not lumped with known MCMs', () => {
    const deferral = new SubsystemNetworkDeferral(NETWORK_FAILURE_BATCH_TOLERANCE)
    deferral.recordNetworkFailure(null)
    deferral.recordNetworkFailure(null)
    deferral.recordNetworkFailure(null)
    expect(deferral.isDeferred(null)).toBe(true)
    expect(deferral.isDeferred(38)).toBe(false)
  })
})
