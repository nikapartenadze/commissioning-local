/**
 * Classify a remote IP as a loopback address (same machine as the server).
 * Covers:
 *   - IPv4 loopback (127.0.0.1)
 *   - IPv6 loopback (::1)
 *   - IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)
 *
 * Pure function. Never throws. Treats undefined/empty/unknown as non-loopback.
 */
export function isLoopbackIp(ip: string | undefined | null): boolean {
  if (!ip) return false
  const normalized = ip.trim()
  if (normalized === '') return false
  if (normalized === '127.0.0.1') return true
  if (normalized === '::1') return true
  if (normalized === '::ffff:127.0.0.1') return true
  return false
}
