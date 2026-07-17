/**
 * Render status for a safety-page list section (e.g. STO bypass zones).
 *
 * Honesty rule: a FAILED fetch must NOT render like an empty result. The safety
 * view fetched zones with `.catch(() => setZones([]))` and rendered
 * `zones.length === 0` as "No STO bypass zones configured" — so a transient
 * fetch failure told the operator there was nothing to bypass on a subsystem
 * that actually HAS safety zones. Error must win over empty.
 */
export type SafetySectionStatus = 'loading' | 'error' | 'empty' | 'ready'

export function safetySectionStatus(
  loading: boolean,
  error: boolean,
  count: number,
): SafetySectionStatus {
  if (loading) return 'loading'
  if (error) return 'error'      // a failed load is NEVER shown as "none configured"
  if (count <= 0) return 'empty'
  return 'ready'
}
