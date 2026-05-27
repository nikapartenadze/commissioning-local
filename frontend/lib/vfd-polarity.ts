/**
 * VFD direction-polarity helpers — pure (no PLC/native deps) so they can be
 * unit-tested. Used by the validation writer to re-assert a recorded polarity
 * to the PLC on (re)connect, the same way Valid_Map/Valid_HP/Valid_Direction
 * are re-asserted.
 *
 * The "Polarity" L2 cell is the source of truth: "<INITIALS> <DATE> · Normal"
 * or "· Inverter". Normal routes Drive_Outputs.DirectionCmd_0 (forward),
 * Inverter routes DirectionCmd_1 (reverse). Per AOI rung 13 the latch settles
 * only when Normal_Polarity is high AND Reverse_Polarity is low, so both bits
 * are always written as a pair.
 */

export type Polarity = 'Normal' | 'Inverter'

export interface FlagWrite {
  field: string
  value: number
}

/** Validation CMD flags asserted (=1) for every validated VFD. */
export const VALIDATION_FLAGS = ['Valid_Map', 'Valid_HP', 'Valid_Direction'] as const

/** Parse the recorded polarity out of a "Polarity" L2 stamp; null when unrecorded. */
export function parsePolarity(stamp: string | null | undefined): Polarity | null {
  if (!stamp) return null
  if (/\bInverter\b/i.test(stamp)) return 'Inverter'
  if (/\bNormal\b/i.test(stamp)) return 'Normal'
  return null
}

/**
 * CMD bit writes that re-assert a recorded polarity (the Normal/Reverse pair).
 * Returns [] when no polarity was recorded — in that case we leave the drive's
 * direction routing untouched rather than forcing a default.
 */
export function polarityFlagWrites(stamp: string | null | undefined): FlagWrite[] {
  const p = parsePolarity(stamp)
  if (!p) return []
  return [
    { field: 'Normal_Polarity', value: p === 'Normal' ? 1 : 0 },
    { field: 'Reverse_Polarity', value: p === 'Inverter' ? 1 : 0 },
  ]
}

/**
 * All CMD writes for one validated device: the three validation flags (=1)
 * plus the polarity pair (only when a polarity is recorded).
 */
export function deviceFlagWrites(polarityRaw: string | null): FlagWrite[] {
  return [
    ...VALIDATION_FLAGS.map((field) => ({ field, value: 1 })),
    ...polarityFlagWrites(polarityRaw),
  ]
}
