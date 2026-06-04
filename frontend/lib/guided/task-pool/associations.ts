import type { SnapshotDevice, SnapshotIo } from './snapshot-types'

/**
 * Functional-check ↔ associated-device mapping (committee decision D3).
 *
 * A functional task (e.g. "Check JPE Functionality") may not enter the pool
 * until its ASSOCIATED devices have been IO checked — the JPE itself, its
 * beacon, its jam-reset pushbutton, etc. Those relationships live in the PLC
 * program, which the field tool can't parse; what it CAN use is the naming
 * convention the same program enforces: related points share a location
 * prefix (`PS8_10_CH4_JPE1`, `PS8_10_CH4_BCN1`, `PS8_10_CH4_JR1` are one
 * group, prefix `PS8_10_CH4`).
 *
 * Pure module — fed SnapshotDevices, returns the associated IOs and which of
 * them still need an IO-check result. When no prefix can be derived (or no
 * IO matches it) the functional task falls back to the global gating rules
 * only — incremental, never over-blocking on unknown data.
 */

/** Device-type tokens that terminate a functional device name. */
const TYPE_TOKEN = /^(.+?)[_-](JPE|TPE|FPE|EPC|ENC|BCN|JR|PB|SS|PE)\d*[A-Z]?$/i

/**
 * Location prefix of a functional device name: everything before the trailing
 * `_<TYPE><n>` token. `null` when the name doesn't follow the convention.
 *
 *   "PS8_10_CH4_JPE1" → "PS8_10_CH4"
 *   "UL17_19"         → null (no type token — can't derive a group)
 */
export function locationPrefixOf(deviceName: string | null | undefined): string | null {
  if (!deviceName) return null
  const m = deviceName.trim().match(TYPE_TOKEN)
  return m ? m[1] : null
}

export interface AssociatedIo {
  deviceName: string
  io: SnapshotIo
}

/**
 * All IOs across the subsystem that belong to the functional device's location
 * group — matched when the IO's tag name or description starts with
 * `<prefix>_` / `<prefix>-` (exact-boundary so `..._CH4` never matches
 * `..._CH40`). Empty array when no prefix or nothing matches.
 */
export function associatedIosFor(
  functionalDeviceName: string | null | undefined,
  devices: SnapshotDevice[],
): AssociatedIo[] {
  const prefix = locationPrefixOf(functionalDeviceName)
  if (!prefix) return []
  const matches = (s: string | null | undefined): boolean => {
    if (!s) return false
    if (s.length <= prefix.length) return false
    if (!s.toUpperCase().startsWith(prefix.toUpperCase())) return false
    const boundary = s[prefix.length]
    return boundary === '_' || boundary === '-'
  }
  const out: AssociatedIo[] = []
  for (const d of devices) {
    for (const io of d.ios) {
      if (matches(io.name) || matches(io.description)) {
        out.push({ deviceName: d.deviceName, io })
      }
    }
  }
  return out
}

/**
 * Short labels for the associated IOs still missing an IO-check result —
 * what the unmet-dependency message lists. "Checked" = has a recorded result
 * (Passed or Failed), matching how IO-check task completion is derived.
 */
export function pendingAssociatedLabels(associated: AssociatedIo[]): string[] {
  const pending = associated.filter((a) => a.io.result == null)
  return pending.map((a) => shortIoLabel(a.io))
}

/** Tag tail after the location prefix ("PS8_10_CH4_BCN1" → "BCN1"), else name. */
function shortIoLabel(io: SnapshotIo): string {
  const name = io.name || io.description || '?'
  const m = name.match(/[_-]((?:JPE|TPE|FPE|EPC|ENC|BCN|JR|PB|SS|PE)\d*[A-Z]?)(?:[:.].*)?$/i)
  return m ? m[1] : name
}
