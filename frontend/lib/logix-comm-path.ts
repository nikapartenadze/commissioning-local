/**
 * Logix SDK communications-path helpers, shared by the server (batch upload)
 * and the client (controller console / batch dialog) so there is a single
 * canonical implementation of the IP+slot ⇄ Studio-5000 comm-path mapping.
 *
 * Extracted verbatim from components/controller-console.tsx — behaviour is
 * intentionally identical to the original local copies.
 */

// Build the Logix SDK communications path from the IP + backplane path the
// operator already knows (same fields as the Connect config). "1,0" -> slot 0.
export function commFrom(ip: string, path: string): string {
  const ipt = ip.trim()
  if (!ipt) return ''
  const nums = (path || '').split(/[^0-9]+/).filter(Boolean)
  const slot = nums.length ? nums[nums.length - 1] : '0'
  return `AB_ETH-2\\${ipt}\\Backplane\\${slot}`
}

// Pull IP + slot back out of a stored Studio 5000 comm path so the two fields
// reflect what the ACD actually targets.
export function parseComm(s: string): { ip: string; path: string } | null {
  if (!s) return null
  const ipm = s.match(/(\d{1,3}\.){3}\d{1,3}/)
  if (!ipm) return null
  const slotm = s.match(/Backplane[\\/](\d+)/i)
  return { ip: ipm[0], path: `1,${slotm ? slotm[1] : '0'}` }
}
