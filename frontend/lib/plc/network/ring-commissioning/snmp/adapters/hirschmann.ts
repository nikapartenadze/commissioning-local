import type { RingState } from '../../types'
import type { SnmpRow } from '../parse'
import { OID } from '../mibs'

/** Decode the Hirschmann MRP manager ring state: open(1) / closed(2) /
 *  undefined(3). closed => redundancy intact. */
export function decodeMrpRingState(rows: SnmpRow[]): RingState {
  const row = rows.find(r => r.oid.startsWith(OID.hmMrpMRMRealRingState))
  if (!row) return { closed: false, source: 'mrp', reason: 'MRP ring state unreadable' }
  const v = Number(row.value)
  if (v === 2) return { closed: true, source: 'mrp', reason: 'MRP ring closed (redundancy intact)' }
  if (v === 1) return { closed: false, source: 'mrp', reason: 'MRP ring OPEN' }
  return { closed: false, source: 'mrp', reason: `MRP ring state ${v} (undefined)` }
}
