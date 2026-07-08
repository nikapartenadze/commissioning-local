import type { RingState } from '../../types'
import type { SnmpRow } from '../parse'
import { OID } from '../mibs'

/**
 * Decode Moxa Turbo Ring state. The OID is a documented placeholder until it is
 * confirmed on MTN6 hardware from the Moxa Industrial Protocols manual — until
 * then this never reports a green ring (safety: no false-green).
 */
export function decodeTurboRingState(rows: SnmpRow[]): RingState {
  if (!OID.moxaTurboRingState) {
    return { closed: false, source: 'moxa', reason: 'Moxa Turbo Ring OID unconfigured — confirm on hardware' }
  }
  const row = rows.find(r => r.oid.startsWith(OID.moxaTurboRingState))
  if (!row) return { closed: false, source: 'moxa', reason: 'Moxa ring state unreadable' }
  // Healthy state code is TBD-from-hardware; treat the documented healthy value.
  const v = Number(row.value)
  return v === 1
    ? { closed: true, source: 'moxa', reason: 'Turbo Ring healthy' }
    : { closed: false, source: 'moxa', reason: `Turbo Ring state ${v}` }
}
