/**
 * PLC connection-loss decision (pure, no native deps so it's unit-testable).
 *
 * Background — the false-disconnect thrash (audit 2026-05-26):
 * The tag reader used to flag the PLC "disconnected" after 3 consecutive read
 * cycles where failures merely OUTNUMBERED successes. On a busy controller, a
 * brief Wi-Fi blip, or competing CIP load (network poller, validation writer,
 * status breadcrumb polls), a handful of marginal cycles would tear down a
 * perfectly reachable connection, destroy all 600+ tag handles, and recreate
 * them — and if conditions were still marginal the rebuild failed too, looping.
 * Field logs showed 74 error→reconnect transitions, most preceded by
 * "Tag creation complete: 0 success, N failed, PLC reachable: true".
 *
 * The rule here is deliberately conservative about declaring loss:
 *   - ANY successful read in a cycle proves the CIP session is alive. libplctag
 *     silently retries the failed tags next cycle, so we keep the connection up
 *     and reset the streak. Partial failures NEVER disconnect.
 *   - The PLC is declared lost only when EVERY attempted read fails for both
 *     CONNECTION_LOSS_MIN_CYCLES consecutive cycles AND CONNECTION_LOSS_MIN_MS
 *     of wall-clock time — so a sub-second burst of fast-failing cycles can't
 *     trigger a reconnect, but a genuine outage still does within a few seconds.
 *
 * This is intentionally one-directional-safe: a genuinely dead PLC (all reads
 * failing) still triggers reconnect; we only removed the false positives.
 */

/** Consecutive total-failure cycles required before declaring the PLC lost. */
export const CONNECTION_LOSS_MIN_CYCLES = 3;
/** Minimum sustained total-failure duration (ms) before declaring the PLC lost. */
export const CONNECTION_LOSS_MIN_MS = 5_000;

export interface ConnectionEvalState {
  isConnected: boolean;
  /** Consecutive cycles in which every attempted read failed. */
  totalFailureCycles: number;
  /** Wall-clock ms of the first cycle in the current total-failure streak (0 = not failing). */
  firstFailureAt: number;
}

export interface ConnectionVerdict {
  state: ConnectionEvalState;
  /** undefined = no status change; true = became connected; false = became disconnected. */
  changedTo?: boolean;
}

export const INITIAL_CONNECTION_STATE: ConnectionEvalState = {
  isConnected: true,
  totalFailureCycles: 0,
  firstFailureAt: 0,
};

/**
 * Decide the connection status from one read cycle's success/fail counts.
 * Pure — caller supplies the previous state and the current time.
 */
export function connectionVerdict(
  prev: ConnectionEvalState,
  successCount: number,
  failCount: number,
  now: number,
): ConnectionVerdict {
  // Any successful read proves the session is alive → reset the failure streak.
  if (successCount > 0) {
    return {
      state: { isConnected: true, totalFailureCycles: 0, firstFailureAt: 0 },
      changedTo: prev.isConnected ? undefined : true,
    };
  }

  // Nothing attempted this cycle (no tags, or aborted) → no signal either way.
  if (failCount === 0) {
    return { state: prev };
  }

  // Total failure: every attempted read failed this cycle.
  const firstFailureAt = prev.firstFailureAt === 0 ? now : prev.firstFailureAt;
  const totalFailureCycles = prev.totalFailureCycles + 1;
  const shouldDisconnect =
    prev.isConnected &&
    totalFailureCycles >= CONNECTION_LOSS_MIN_CYCLES &&
    now - firstFailureAt >= CONNECTION_LOSS_MIN_MS;

  return {
    state: {
      isConnected: shouldDisconnect ? false : prev.isConnected,
      totalFailureCycles,
      firstFailureAt,
    },
    changedTo: shouldDisconnect ? false : undefined,
  };
}
