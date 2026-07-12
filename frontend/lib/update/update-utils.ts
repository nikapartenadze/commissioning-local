import fs from 'fs'
import path from 'path'
import { configService } from '@/lib/config'
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types'
import { resolveUpdateStatePath } from '@/lib/storage-paths'

/**
 * Fallback manifest URL used when neither UPDATE_MANIFEST_URL env nor
 * config.updateManifestUrl is set. Points at the cloud endpoint that
 * scans `public/downloads/` and returns the highest-versioned installer.
 * Keeping this defaulted means every tablet gets self-update for free
 * after upgrading to a build that includes this code — no per-tablet
 * config.json edit required.
 */
const DEFAULT_MANIFEST_URL = `${EMBEDDED_REMOTE_URL.replace(/\/$/, '')}/api/releases/latest`

export interface ReleaseManifest {
  version: string
  installerUrl: string
  publishedAt?: string
  notes?: string
  /** Version-lock policy (FV-HARDENING-PLAN.md F7/C3): tools below minVersion
   *  lock out with an update screen. Absent/null on clouds without a policy. */
  minVersion?: string | null
  lockMessage?: string | null
}

export interface LocalUpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting' | 'success' | 'error'
  message?: string
  version?: string
  startedAt?: string
  completedAt?: string
  installerUrl?: string
}

export function getCurrentAppVersion(): string {
  if (process.env.APP_VERSION && process.env.APP_VERSION.trim()) {
    return process.env.APP_VERSION.trim()
  }

  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json')
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string }
    if (parsed.version) return parsed.version
  } catch {
    // ignore
  }

  return '0.0.0-dev'
}

export function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/i, '').split('.').map(part => parseInt(part, 10) || 0)
  const right = b.replace(/^v/i, '').split('.').map(part => parseInt(part, 10) || 0)
  const max = Math.max(left.length, right.length)

  for (let i = 0; i < max; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l > r) return 1
    if (l < r) return -1
  }

  return 0
}

export async function getUpdateManifestUrl(): Promise<string> {
  if (process.env.UPDATE_MANIFEST_URL && process.env.UPDATE_MANIFEST_URL.trim()) {
    return process.env.UPDATE_MANIFEST_URL.trim()
  }

  const config = await configService.getConfig()
  const configuredUrl = (config as any).updateManifestUrl
  if (typeof configuredUrl === 'string' && configuredUrl.trim()) {
    return configuredUrl.trim()
  }

  // Default: the cloud's directory-scanning endpoint. Lets every tablet
  // self-update out of the box; per-tablet config edits are only needed
  // when pinning to a non-default manifest (e.g. for staged rollouts).
  return DEFAULT_MANIFEST_URL
}

/**
 * Module-level cache for the release-manifest fetch result. The toolbar pill
 * polls /api/update/status frequently; the field log showed dozens of
 * `SLOW GET /api/update/status → 10001ms` lines because every poll re-hit the
 * cloud and the cloud sometimes took the full 10 s timeout to respond.
 *
 * Cache parameters:
 *   - SUCCESS_TTL_MS:  successful results held for 30 s (next poll picks up
 *                      new releases within half a minute — fine for our use).
 *   - ERROR_TTL_MS:    failed results held for 60 s so we don't pound an
 *                      unreachable endpoint on every poll. Long enough to
 *                      mute the SLOW-log spam, short enough that the pill
 *                      clears within ~1 min once connectivity returns.
 */
type ManifestResult = { manifestUrl: string; manifest: ReleaseManifest | null; error?: string }
const SUCCESS_TTL_MS = 30_000
const ERROR_TTL_MS = 60_000
let cachedManifest: { value: ManifestResult; expiresAt: number } | null = null
/** Deduplicate concurrent fetches — without this, the first 30 s of a slow
 *  manifest fetch could spawn dozens of parallel HTTP requests. */
let inflightManifestFetch: Promise<ManifestResult> | null = null

export async function fetchReleaseManifest(): Promise<ManifestResult> {
  const now = Date.now()
  if (cachedManifest && cachedManifest.expiresAt > now) {
    return cachedManifest.value
  }
  if (inflightManifestFetch) {
    return inflightManifestFetch
  }

  inflightManifestFetch = (async () => {
    const manifestUrl = await getUpdateManifestUrl()
    if (!manifestUrl) {
      const result: ManifestResult = { manifestUrl: '', manifest: null, error: 'Update manifest URL is not configured' }
      cachedManifest = { value: result, expiresAt: Date.now() + ERROR_TTL_MS }
      return result
    }

    try {
      // 4 s timeout sits below the API logger's 5 s SLOW threshold, so a
      // genuinely unreachable manifest URL stops painting the log red on
      // every poll. The cloud was responding inside ~2 s on the good path
      // already, so 4 s leaves comfortable headroom.
      const response = await fetch(manifestUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(4000),
      })

      if (!response.ok) {
        const result: ManifestResult = { manifestUrl, manifest: null, error: `Manifest HTTP ${response.status}` }
        cachedManifest = { value: result, expiresAt: Date.now() + ERROR_TTL_MS }
        return result
      }

      const manifest = await response.json() as ReleaseManifest
      if (!manifest?.version || !manifest?.installerUrl) {
        const result: ManifestResult = { manifestUrl, manifest: null, error: 'Manifest is missing version or installerUrl' }
        cachedManifest = { value: result, expiresAt: Date.now() + ERROR_TTL_MS }
        return result
      }

      const result: ManifestResult = { manifestUrl, manifest }
      cachedManifest = { value: result, expiresAt: Date.now() + SUCCESS_TTL_MS }
      return result
    } catch (error) {
      const result: ManifestResult = {
        manifestUrl,
        manifest: null,
        error: error instanceof Error ? error.message : 'Failed to fetch update manifest',
      }
      cachedManifest = { value: result, expiresAt: Date.now() + ERROR_TTL_MS }
      return result
    }
  })()

  try {
    return await inflightManifestFetch
  } finally {
    inflightManifestFetch = null
  }
}

export function readLocalUpdateState(): LocalUpdateState | null {
  try {
    const statePath = resolveUpdateStatePath()
    if (!fs.existsSync(statePath)) return null
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as LocalUpdateState
  } catch {
    return null
  }
}

/**
 * Best-effort write of the local update state. Used by the command handler
 * to stamp a fresh "checking" the moment a cloud-pushed update launches, so
 * the heartbeat stops reporting the PREVIOUS run's success/error while the
 * new install is in flight. install-update.ps1 overwrites this immediately
 * with its own Write-State progression. Never throws.
 */
export function writeLocalUpdateState(state: LocalUpdateState): void {
  try {
    fs.writeFileSync(resolveUpdateStatePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // non-fatal — the ps1 will write its own state on the next step
  }
}

// ── Stuck-state recovery ────────────────────────────────────────────────────
//
// An update writes update-status.json through a lifecycle:
//   checking → downloading → installing → restarting → success | error
// The first four are NON-TERMINAL ("in progress"). If install-update.ps1 dies
// before it writes a terminal state — e.g. Stop-Service tears down the service
// process tree and takes the detached updater child with it — the file is
// frozen on a non-terminal value. Without recovery that is permanent: the UI
// shows "Updating…" forever AND every retry is refused with "update already in
// progress", so one interrupted attempt bricks the channel for that tablet
// until someone hand-deletes the file. The helpers below heal that:
//   - a non-terminal state older than STALE_UPDATE_MS is treated as failed
//   - on every boot we reconcile against the actually-running version
const STALE_UPDATE_MS = 15 * 60 * 1000

const NON_TERMINAL_STATUSES: ReadonlyArray<LocalUpdateState['status']> = [
  'checking', 'downloading', 'installing', 'restarting',
]

export function isNonTerminalUpdateStatus(status: string): boolean {
  return (NON_TERMINAL_STATUSES as ReadonlyArray<string>).includes(status)
}

/**
 * True when a non-terminal update has been sitting longer than the window a
 * real install could plausibly take (download + install + restart + health
 * check). A missing/unparseable startedAt is treated as stale — we can't prove
 * it's live, so don't let it block forever. Pure (now injectable for tests).
 */
export function isStaleUpdate(state: LocalUpdateState | null, now: number = Date.now()): boolean {
  if (!state || !isNonTerminalUpdateStatus(state.status)) return false
  const started = state.startedAt ? Date.parse(state.startedAt) : NaN
  if (!Number.isFinite(started)) return true
  return now - started > STALE_UPDATE_MS
}

/**
 * Project the on-disk state into what callers should ACT on. A stale
 * non-terminal state is surfaced as an `error` so the UI un-sticks and the
 * cloud banner stops reporting a phantom install. Pure.
 */
export function computeEffectiveUpdateState(
  state: LocalUpdateState | null,
  now: number = Date.now(),
): LocalUpdateState | null {
  if (!state) return null
  if (!isStaleUpdate(state, now)) return state
  return {
    ...state,
    status: 'error',
    message: `Update did not complete — stuck at "${state.status}" for over ${Math.round(STALE_UPDATE_MS / 60000)} min. Re-push from the cloud to retry.`,
    completedAt: new Date(now).toISOString(),
  }
}

/**
 * Decide how to heal update-status.json at startup. Only acts on a
 * non-terminal state (a clean success/error/idle is left alone). The running
 * version is ground truth: if we booted on (or past) the target, the install
 * actually landed → success; otherwise the updater died mid-flight → error.
 * Returns the state to persist, or null when no action is needed. Pure.
 */
export function computeBootReconciliation(
  state: LocalUpdateState | null,
  currentVersion: string,
  now: number = Date.now(),
): LocalUpdateState | null {
  if (!state || !isNonTerminalUpdateStatus(state.status)) return null
  const target = state.version
  const completedAt = new Date(now).toISOString()
  if (target && compareVersions(currentVersion, target) >= 0) {
    return {
      ...state,
      status: 'success',
      message: `Update completed (verified on startup: running ${currentVersion})`,
      completedAt,
    }
  }
  return {
    ...state,
    status: 'error',
    message: `Update interrupted — tool restarted while status was "${state.status}" (running ${currentVersion}${target ? `, target ${target}` : ''})`,
    completedAt,
  }
}

/**
 * Effective state for the UI / heartbeat / cloud banner. Wraps the raw read
 * with the staleness projection so a dead install never reads as "in progress".
 */
export function getEffectiveUpdateState(): LocalUpdateState | null {
  return computeEffectiveUpdateState(readLocalUpdateState())
}

/**
 * True only when a real install is genuinely live (non-terminal AND not stale).
 * This is the gate the command handler and the install route use to refuse
 * stacking — a stale state no longer blocks a fresh retry.
 */
export function isUpdateInProgress(): boolean {
  const state = readLocalUpdateState()
  return !!state && isNonTerminalUpdateStatus(state.status) && !isStaleUpdate(state)
}

/**
 * Heal a poisoned update-status.json once, at server startup. Safe to call
 * unconditionally — no-ops on a terminal/absent state. Never throws.
 */
export function reconcileUpdateStateOnBoot(): void {
  try {
    const healed = computeBootReconciliation(readLocalUpdateState(), getCurrentAppVersion())
    if (healed) {
      writeLocalUpdateState(healed)
      console.log(`[Update] Boot reconciliation: status → ${healed.status} (${healed.message})`)
    }
  } catch {
    // best-effort — a failed reconcile must not block startup
  }
}

export function resolveUpdateScriptPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'tools', 'install-update.ps1'),
    path.resolve(process.cwd(), 'dist-server', 'tools', 'install-update.ps1'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return null
}
