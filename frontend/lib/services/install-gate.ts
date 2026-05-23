/**
 * Install-status Gate
 *
 * Per-machine opt-in that blocks Pass/Fail attempts on IOs whose
 * mechanical installation is not yet marked 'complete'. Driven by
 * config.json's `requireInstalledForTesting` field (default off).
 *
 * Historical note: this rule used to be unconditional. It was removed from
 * `app/api/ios/[id]/test/route.ts` because techs commonly test devices
 * before the install tracker is updated. This helper re-introduces it as
 * an explicit opt-in for projects like CDW5 where the customer requires
 * installation sign-off before testing can begin.
 *
 * SPARE IOs are exempt — they have their own existing rule
 * (SPARE IOs cannot be passed) and their installation status is irrelevant.
 *
 * Reads the config synchronously so the gate adds no latency to the hot
 * test path. The config service hot-reloads from file watch, so flipping
 * the flag in config.json takes effect on the next call without restart.
 */

import type { Io } from '@/lib/db-sqlite'
import { configService } from '@/lib/config/config-service'

export interface GateDecision {
  allowed: boolean
  /** Human-readable reason. Only populated when allowed is false. */
  error?: string
}

const ALLOWED: GateDecision = { allowed: true }

/**
 * Returns `{ allowed: true }` unless the flag is on AND the IO is not a
 * SPARE AND its installation status is anything other than 'complete'.
 * Case-insensitive on the status value to tolerate cloud-side variation.
 */
export function checkInstallGate(io: Io): GateDecision {
  const cfg = configService.getConfigSync()
  if (cfg.requireInstalledForTesting !== true) return ALLOWED

  const desc = (io.Description ?? '').toUpperCase()
  if (desc.includes('SPARE')) return ALLOWED

  const status = (io.InstallationStatus ?? '').toLowerCase()
  if (status === 'complete') return ALLOWED

  const label = io.Name ?? `IO ${io.id}`
  const statusLabel = status || 'not set'
  return {
    allowed: false,
    error: `Installation not complete for ${label} (status: ${statusLabel}). Testing is gated by installation status on this machine — clear the gate by completing installation, or flip requireInstalledForTesting in config.json.`,
  }
}
