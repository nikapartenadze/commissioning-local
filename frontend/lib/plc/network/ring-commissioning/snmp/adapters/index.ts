import type { RingState } from '../../types'
import type { SnmpRow } from '../parse'
import { decodeMrpRingState } from './hirschmann'
import { decodeTurboRingState } from './moxa'
import { noRingState } from './generic'

export type Vendor = 'moxa' | 'hirschmann' | 'generic'

/** Pick a vendor from an explicit hint, else the device naming, else generic. */
export function selectVendor(deviceName: string, hint?: string): Vendor {
  const h = (hint ?? '').toLowerCase()
  if (h.includes('moxa')) return 'moxa'
  if (h.includes('hirschmann') || h.includes('octopus')) return 'hirschmann'
  if (/moxa/i.test(deviceName)) return 'moxa'
  if (/(^|_)DPM\d*/i.test(deviceName)) return 'hirschmann' // DPM = Hirschmann Octopus
  return 'generic'
}

/** Decode the vendor's ring-state MIB rows into a RingState. */
export function decodeRingState(vendor: Vendor, rows: SnmpRow[]): RingState {
  if (vendor === 'hirschmann') return decodeMrpRingState(rows)
  if (vendor === 'moxa') return decodeTurboRingState(rows)
  return noRingState()
}
