import { isNetworkLevelFailure } from '@/lib/cloud/sync-failure-classification'

/**
 * How the manual "Sync L2 now" push should update a queued row after a batch
 * failure.
 *
 * The manual path historically struck (RetryCount++) on EVERY non-2xx response —
 * including 401 / 429 / 5xx, which are network-level (the cloud never ruled on
 * the row). That silently marched HEALTHY rows toward the park cap during a
 * cloud restart / throttle window — the 2026-06-04 TPA8/MCM08 data-loss class
 * that every background drain was hardened against but this manual button was
 * not. A network-level failure must NOT burn a strike; only a genuine cloud
 * verdict (a non-network 4xx) counts toward the cap.
 */
export function manualSyncFailureUpdate(
  failure: { thrown?: boolean; httpStatus?: number; message?: string },
): { strike: boolean; lastError: string } {
  const networkLevel = isNetworkLevelFailure({ thrown: failure.thrown, httpStatus: failure.httpStatus })
  const lastError = failure.thrown
    ? `network: ${failure.message ?? 'error'}`
    : `HTTP ${failure.httpStatus ?? '???'}${networkLevel ? ' (network-level, no strike)' : ''}`
  return { strike: !networkLevel, lastError }
}
