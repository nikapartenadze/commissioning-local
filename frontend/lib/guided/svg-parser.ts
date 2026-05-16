/**
 * Parse SCADA-export device ids out of an SVG string in document order.
 *
 * The Inkscape-driven SCADA export uses two shapes for devices:
 *   - <g id="...">  — composite devices (VFDs, FIOMs, etc.) where the id
 *     wraps a group of child <rect>/<path> elements.
 *   - <path id="..."> — flat sensor/affordance icons (photoeyes,
 *     beacons, pushbuttons, EPCs) drawn as a single path.
 *
 * Both forms carry the device name in the id attribute, matching the
 * NetworkDeviceName column in the local Ios table (with the LPE_PD
 * suffix exception resolved at the join layer).
 *
 * Order is preserved as it appears in the file — SCADA lays out devices
 * in floor-walk order, and we follow it.
 *
 * Regex over a full XML parser is intentional: zero deps, the SVGs are
 * machine-generated with predictable structure, and we only extract id.
 */
const DEVICE_ID_RE =
  /<(?:g|path)\b[^>]*\bid\s*=\s*(['"])([^'"]+)\1[^>]*>/g

export function parseDeviceIdsFromSvg(svg: string): string[] {
  const ids: string[] = []
  let m: RegExpExecArray | null
  DEVICE_ID_RE.lastIndex = 0
  while ((m = DEVICE_ID_RE.exec(svg)) !== null) {
    ids.push(m[2])
  }
  return ids
}
