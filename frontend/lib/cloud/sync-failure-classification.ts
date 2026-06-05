/**
 * Classifies a failed cloud push: did the cloud app give a definitive
 * verdict on this payload, or did the attempt die somewhere in transit?
 *
 * Born from the 2026-06-04 TPA8/MCM08 incident: the PendingSyncs retry cap
 * (10 strikes → row deleted) counted plain network failures as strikes, so
 * a site with no internet silently emptied its sync queue in ~100 seconds
 * per row. The manual-pull guard then saw 0 pending rows and allowed a
 * destructive pull that wiped 818 unsynced results.
 *
 * The retry cap exists to clear rows the CLOUD refuses (version mismatch /
 * updatedCount=0) so they don't block catch-up pulls forever. It must never
 * fire for failures where the cloud never ruled on the payload.
 */
export interface SyncFailureShape {
  /** True when fetch threw (DNS, connect timeout, aborted, conn refused). */
  thrown?: boolean
  /** HTTP status when a response was received. Undefined = no HTTP attempt (offline short-circuit, missing config). */
  httpStatus?: number
}

/**
 * Returns true when the failure is network-level / environmental — the row
 * is still good and must NOT have its RetryCount incremented:
 * - fetch threw, or no HTTP attempt was made (offline / no remote URL)
 * - HTTP 401: auth/config problem on the tool, not a verdict on the row
 * - HTTP 429: rate limited — the cloud REFUSED to process the row (no verdict
 *   on its value), it just throttled. Retrying after the window succeeds.
 * - HTTP 5xx: cloud app or reverse proxy down/overloaded
 *
 * Returns false when the cloud actually processed the request and said no
 * (2xx body verdicts like updatedCount=0, and non-401/429 4xx — the latter are
 * treated as permanent rejections by the caller and deleted immediately).
 *
 * The 429 case is bug B1 from the 2026-06-05 MCM11 incident: the cloud
 * rate-limits push at 300/min/key and a flaky link's retry flood trips it.
 * Before this, 429 was classed as a permanent 4xx and the result was DELETED
 * on the first throttle — silent field-data loss. 429 is transient.
 */
export function isNetworkLevelFailure(failure: SyncFailureShape): boolean {
  if (failure.thrown) return true
  if (failure.httpStatus === undefined) return true
  if (failure.httpStatus === 401) return true
  if (failure.httpStatus === 429) return true
  if (failure.httpStatus >= 500) return true
  return false
}
