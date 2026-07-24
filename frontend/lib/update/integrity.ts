/**
 * Installer integrity helpers for the auto-update channel.
 *
 * Pure functions (no fs/env access) so the policy is unit-testable. The
 * install pipeline (lib/update/install-launcher.ts) is the only consumer;
 * it wires in the env-derived `allowHttp` flag and passes the validated
 * sha256 through to tools/install-update.ps1, which does the actual
 * Get-FileHash check after download.
 *
 * Threat model: a compromised cloud (or anyone who can shape the release
 * manifest / update command) could previously point a tablet at an arbitrary
 * .exe that runs silently as SYSTEM. The sha256 pins the exact bytes; the
 * https requirement stops a plain on-path attacker from swapping the payload
 * of a legitimate URL. Neither is full trust (that needs code-signing) but
 * both remove the "any URL, any bytes, zero verification" hole.
 */

const SHA256_HEX = /^[0-9a-fA-F]{64}$/

export function isValidSha256(value: string): boolean {
  return SHA256_HEX.test(value)
}

/** Hosts allowed to use plain http even when https is enforced: the tool
 *  talking to itself / a same-box test cloud is not exposed to the network. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export interface UrlPolicyOptions {
  /**
   * When true, plain http is accepted for ANY host. Set from the
   * UPDATE_ALLOW_HTTP env var (default OFF → https-only except loopback).
   * Exists for the battle/soak rigs and LAN test setups where the "cloud" is
   * an internal docker service reached over http (CLOUD_URL_OVERRIDE=
   * http://cloud:3000 / http://linkshaper:3000).
   */
  allowHttp?: boolean
}

export interface UrlPolicyResult {
  ok: boolean
  /** Present when ok is false — a caller-facing rejection message. */
  reason?: string
}

/**
 * Enforce the installer-URL transport policy:
 *   - must parse as a URL with http: or https: scheme
 *   - http: is only accepted for loopback hosts, unless allowHttp
 */
export function validateInstallerUrl(rawUrl: string, opts: UrlPolicyOptions = {}): UrlPolicyResult {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: `installerUrl is not a valid URL: "${rawUrl.slice(0, 80)}"` }
  }

  const protocol = parsed.protocol.toLowerCase()
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: `installerUrl must be http(s): got "${rawUrl.slice(0, 80)}"` }
  }

  if (protocol === 'http:') {
    const host = parsed.hostname.toLowerCase()
    if (!LOOPBACK_HOSTS.has(host) && !opts.allowHttp) {
      return {
        ok: false,
        reason:
          `installerUrl must be https for non-loopback hosts (got http://${host}). ` +
          'Set UPDATE_ALLOW_HTTP=1 only on isolated test rigs.',
      }
    }
  }

  return { ok: true }
}

/** True when the UPDATE_ALLOW_HTTP env value opts this host into plain http. */
export function envAllowsHttp(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}
