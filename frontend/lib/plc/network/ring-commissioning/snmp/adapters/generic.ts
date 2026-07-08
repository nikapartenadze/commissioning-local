import type { RingState } from '../../types'

/** No vendor ring-state source — the ring verdict must come from DLR or a
 *  configured vendor OID. Never green. */
export function noRingState(): RingState {
  return { closed: false, source: 'none', reason: 'No vendor ring-state source (use DLR or configure a vendor OID)' }
}
