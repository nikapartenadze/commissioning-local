/**
 * Per-subsystem network-failure deferral for the IO push drain.
 *
 * Central-server instances drain ONE global PendingSyncs queue that mixes rows
 * from many MCMs (ORDER BY CreatedAt ASC LIMIT 50). The drain previously kept a
 * SINGLE batch-wide network-failure counter and hard-`break`ed the whole batch
 * after 3 network-level failures (offline / 401 / 403 / 429 / 5xx — see
 * isNetworkLevelFailure). That break is correct for a single-MCM field tool (a
 * truly-down cloud fails every row identically, so stop and save the 15s
 * timeouts), but on a multi-MCM box it is a starvation bug: a single
 * permanently-misconfigured MCM (revoked key, deleted/mismatched subsystem)
 * accumulates the OLDEST rows, so its failures always sort FIRST and trip the
 * break before any healthy MCM's newer rows are reached — every cycle, forever.
 * The healthy MCMs' results never sync until an operator fixes the unrelated
 * MCM; lose the box first and that field work is gone.
 *
 * This tracker replaces the batch-wide counter with a PER-SUBSYSTEM one:
 *  - A network-level failure counts only against ITS OWN subsystem.
 *  - Once a subsystem reaches the tolerance it is DEFERRED for the rest of the
 *    cycle; the caller skips its remaining rows WITHOUT a network call (so the
 *    original "don't hammer a down cloud" efficiency is preserved — a
 *    single-MCM box still makes exactly `tolerance` attempts then stops).
 *  - Healthy subsystems are never deferred, so their rows are always attempted
 *    regardless of a sibling MCM's broken config or queue position.
 *
 * `null` (unknown-subsystem) rows share one bucket, kept distinct from any
 * known numeric subsystem id.
 */
export class SubsystemNetworkDeferral {
  private readonly counts = new Map<number | null, number>()
  private readonly deferred = new Set<number | null>()

  constructor(private readonly tolerance: number) {}

  /**
   * True when this subsystem has already exhausted the tolerance this cycle.
   * The caller should skip the row without making a network call.
   */
  isDeferred(subsystemId: number | null): boolean {
    return this.deferred.has(subsystemId)
  }

  /**
   * Record one network-level failure for a subsystem. Returns true if THIS
   * failure just tipped the subsystem over the tolerance (now deferred).
   */
  recordNetworkFailure(subsystemId: number | null): boolean {
    const next = (this.counts.get(subsystemId) ?? 0) + 1
    this.counts.set(subsystemId, next)
    if (next >= this.tolerance && !this.deferred.has(subsystemId)) {
      this.deferred.add(subsystemId)
      return true
    }
    return false
  }

  /** Number of subsystems deferred so far this cycle (for logging). */
  get deferredCount(): number {
    return this.deferred.size
  }
}
