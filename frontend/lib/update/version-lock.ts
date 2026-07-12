import fs from 'fs'
import path from 'path'
import type { NextFunction, Request, Response } from 'express'
import { compareVersions, fetchReleaseManifest, getCurrentAppVersion, isUpdateInProgress } from '@/lib/update/update-utils'
import { resolveUpdateStatePath } from '@/lib/storage-paths'

/**
 * Cloud-controlled minimum-version lockout (FV-HARDENING-PLAN.md F7).
 *
 * Why: the 2026-07-11 MCM04/MCM11 FV loss happened on a box still running
 * v2.42.10 after the destructive-pull fix had shipped — "boxes kept running old
 * versions and nobody knew". Mandate: outdated tool versions must be locked
 * out, "even if they have to stop for 5 min".
 *
 * How: the cloud release manifest (GET /api/releases/latest — already polled by
 * every v2.38+ tablet via fetchReleaseManifest) gains `minVersion` +
 * `lockMessage`. When the running version is below `minVersion`, every mutating
 * API route 503s with `version_locked` (allowlist below keeps update/health/
 * auth/config/logs usable) and the client shows a full-screen, non-dismissible
 * update overlay. Queued cloud pushes still drain — they are internal library
 * calls, not HTTP through the Express router.
 *
 * Fail-open rule: a tool that has NEVER seen a policy and cannot reach the
 * cloud must keep working (offline-first is the product). The last-seen policy
 * is persisted beside update-status.json so a lock survives restarts and brief
 * cloud outages — a locked tool cannot unlock itself by going offline.
 */

export interface VersionLockPolicy {
  /** Minimum allowed tool version; null = no lock configured. */
  minVersion: string | null
  /** Operator-facing message shown on the lock screen. */
  lockMessage: string | null
  /** ISO timestamp of when this policy was fetched from the cloud. */
  fetchedAt: string
  /** Per-machine quarantine (2026-07-12): admin froze THIS box regardless of
   *  version. Delivered via the heartbeat response, persisted like the rest of
   *  the policy so it survives restarts/offline. */
  quarantined?: boolean
  quarantineMessage?: string | null
}

export interface VersionLockState {
  locked: boolean
  currentVersion: string
  minVersion: string | null
  lockMessage: string | null
  /** True when the lock is a per-machine quarantine (updating won't clear it —
   *  only an admin release does). */
  quarantined: boolean
  quarantineMessage: string | null
  /** 'live' = from this process's manifest fetches; 'persisted' = restored from
   *  disk (cloud not reachable yet); 'none' = no policy ever seen (fail-open). */
  policySource: 'live' | 'persisted' | 'none'
}

/** Pure evaluation — the unit-testable core. */
export function evaluateVersionLock(
  currentVersion: string,
  policy: VersionLockPolicy | null,
  policySource: VersionLockState['policySource'],
): VersionLockState {
  const minVersion = policy?.minVersion ?? null
  const quarantined = policy?.quarantined === true
  const locked = quarantined || (!!minVersion && compareVersions(currentVersion, minVersion) < 0)
  return {
    locked,
    currentVersion,
    minVersion,
    lockMessage: policy?.lockMessage ?? null,
    quarantined,
    quarantineMessage: policy?.quarantineMessage ?? null,
    policySource,
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function resolveVersionLockPath(): string {
  return path.join(path.dirname(resolveUpdateStatePath()), 'version-lock.json')
}

function readPersistedPolicy(): VersionLockPolicy | null {
  try {
    const raw = fs.readFileSync(resolveVersionLockPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'minVersion' in parsed) {
      return {
        minVersion: typeof parsed.minVersion === 'string' ? parsed.minVersion : null,
        lockMessage: typeof parsed.lockMessage === 'string' ? parsed.lockMessage : null,
        fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
        quarantined: parsed.quarantined === true,
        quarantineMessage: typeof parsed.quarantineMessage === 'string' ? parsed.quarantineMessage : null,
      }
    }
  } catch { /* absent/corrupt → no persisted policy */ }
  return null
}

function persistPolicy(policy: VersionLockPolicy): void {
  try {
    fs.writeFileSync(resolveVersionLockPath(), JSON.stringify(policy, null, 2), 'utf8')
  } catch { /* best-effort — in-memory policy still applies this run */ }
}

// ── Module state ────────────────────────────────────────────────────────────

let cachedPolicy: VersionLockPolicy | null = null
let cachedSource: VersionLockState['policySource'] = 'none'
let bootstrapped = false

function bootstrapFromDisk(): void {
  if (bootstrapped) return
  bootstrapped = true
  const persisted = readPersistedPolicy()
  if (persisted) {
    cachedPolicy = persisted
    cachedSource = 'persisted'
  }
}

/** Current lock state, synchronous (uses the last policy seen). */
export function getVersionLockState(): VersionLockState {
  bootstrapFromDisk()
  return evaluateVersionLock(getCurrentAppVersion(), cachedPolicy, cachedSource)
}

/**
 * Re-fetch the policy from the cloud release manifest and re-evaluate.
 * fetchReleaseManifest has its own 30s/60s cache — calling this often is cheap.
 * On fetch failure the previous policy stays in force (fail-open only when no
 * policy was EVER seen).
 */
export async function refreshVersionLock(): Promise<VersionLockState> {
  bootstrapFromDisk()
  const { manifest } = await fetchReleaseManifest()
  if (manifest) {
    const next: VersionLockPolicy = {
      minVersion: typeof manifest.minVersion === 'string' && manifest.minVersion.trim() ? manifest.minVersion.trim() : null,
      lockMessage: typeof manifest.lockMessage === 'string' && manifest.lockMessage.trim() ? manifest.lockMessage.trim() : null,
      fetchedAt: new Date().toISOString(),
      // The manifest knows nothing about per-machine quarantine — preserve the
      // heartbeat-delivered flag across manifest refreshes.
      quarantined: cachedPolicy?.quarantined === true,
      quarantineMessage: cachedPolicy?.quarantineMessage ?? null,
    }
    const changed = !cachedPolicy
      || cachedPolicy.minVersion !== next.minVersion
      || cachedPolicy.lockMessage !== next.lockMessage
    cachedPolicy = next
    cachedSource = 'live'
    if (changed) {
      persistPolicy(next)
      const state = evaluateVersionLock(getCurrentAppVersion(), cachedPolicy, cachedSource)
      console.log(
        `[VersionLock] policy updated: minVersion=${next.minVersion ?? 'none'} → ${state.locked ? 'LOCKED' : 'ok'} (running ${state.currentVersion})`,
      )
    }
  }
  return getVersionLockState()
}

/**
 * Apply policy fields delivered on the heartbeat RESPONSE (second channel
 * beside the manifest — works even when the manifest URL is blocked), plus the
 * per-machine quarantine flag that ONLY the heartbeat carries. Persisted so a
 * quarantined box stays frozen across restarts/offline.
 */
export function applyHeartbeatPolicy(
  versionPolicy: { minVersion?: string | null; lockMessage?: string | null } | null | undefined,
  quarantine: { quarantined?: boolean; message?: string | null } | null | undefined,
): void {
  bootstrapFromDisk()
  if (versionPolicy === undefined && quarantine === undefined) return
  const next: VersionLockPolicy = {
    minVersion: versionPolicy !== undefined
      ? (typeof versionPolicy?.minVersion === 'string' && versionPolicy.minVersion.trim() ? versionPolicy.minVersion.trim() : null)
      : cachedPolicy?.minVersion ?? null,
    lockMessage: versionPolicy !== undefined
      ? (typeof versionPolicy?.lockMessage === 'string' && versionPolicy.lockMessage.trim() ? versionPolicy.lockMessage.trim() : null)
      : cachedPolicy?.lockMessage ?? null,
    fetchedAt: new Date().toISOString(),
    quarantined: quarantine !== undefined ? quarantine?.quarantined === true : cachedPolicy?.quarantined === true,
    quarantineMessage: quarantine !== undefined ? (quarantine?.message ?? null) : cachedPolicy?.quarantineMessage ?? null,
  }
  const changed = !cachedPolicy
    || cachedPolicy.minVersion !== next.minVersion
    || cachedPolicy.lockMessage !== next.lockMessage
    || (cachedPolicy.quarantined === true) !== (next.quarantined === true)
    || (cachedPolicy.quarantineMessage ?? null) !== (next.quarantineMessage ?? null)
  cachedPolicy = next
  cachedSource = 'live'
  if (changed) {
    persistPolicy(next)
    const state = evaluateVersionLock(getCurrentAppVersion(), cachedPolicy, cachedSource)
    console.log(
      `[VersionLock] heartbeat policy: minVersion=${next.minVersion ?? 'none'} quarantined=${state.quarantined} → ${state.locked ? 'LOCKED' : 'ok'}`,
    )
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic policy refresh (server startup). Idempotent. */
export function startVersionLockRefresh(intervalMs = 60_000): void {
  if (refreshTimer) return
  void refreshVersionLock().catch(() => {})
  refreshTimer = setInterval(() => { void refreshVersionLock().catch(() => {}) }, intervalMs)
  refreshTimer.unref?.()
}

/** Test hook: reset module state. Pass rereadDisk:true to simulate a process
 *  restart that restores the persisted policy. */
export function _resetVersionLockForTests(opts: { rereadDisk?: boolean } = {}): void {
  cachedPolicy = null
  cachedSource = 'none'
  bootstrapped = !opts.rereadDisk
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
}
export function _setPolicyForTests(policy: VersionLockPolicy | null, source: VersionLockState['policySource']): void {
  cachedPolicy = policy
  cachedSource = source
  bootstrapped = true
}

// ── Express guard ───────────────────────────────────────────────────────────

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Routes that must keep working while locked:
 *  - /api/update       → see the lock, trigger the install, watch progress
 *  - /api/health       → monitoring / service manager probes
 *  - /api/config       → the update pipeline + support diagnostics read config
 *  - /api/cloud/status → sync-health visibility (is queued work drained?)
 *  - /api/auth         → login must work so the update can be operator-gated
 *  - /api/logs         → support can still pull logs off a locked box
 */
export const VERSION_LOCK_ALLOWLIST = [
  '/api/update',
  '/api/health',
  '/api/config',
  '/api/cloud/status',
  '/api/auth',
  '/api/logs',
] as const

export function isVersionLockExempt(method: string, pathname: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return true
  if (!pathname.startsWith('/api/')) return true // client assets / WS upgrade
  return VERSION_LOCK_ALLOWLIST.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

// isUpdateInProgress() reads update-status.json — cache it briefly so the
// guard doesn't stat the file on every mutating request.
let _updatingCache: { value: boolean; at: number } | null = null
function isUpdatingCached(): boolean {
  if (_updatingCache && Date.now() - _updatingCache.at < 3000) return _updatingCache.value
  const value = isUpdateInProgress()
  _updatingCache = { value, at: Date.now() }
  return value
}

/**
 * Express middleware: 503 on every mutating API route while the lock is
 * active OR an update is genuinely in flight (download/install window —
 * operators wait behind the "updating" screen instead of writing into a
 * process that is about to be replaced). Mounted BEFORE the API router.
 * A failed/stale update reads as terminal (stuck-state healing), so the
 * freeze clears itself and the tool resumes on the old version — the
 * graceful fallback.
 */
export function createVersionLockGuard(
  getState: () => VersionLockState = getVersionLockState,
  isUpdating: () => boolean = isUpdatingCached,
) {
  return function versionLockGuard(req: Request, res: Response, next: NextFunction) {
    if (isVersionLockExempt(req.method, req.path)) return next()
    if (isUpdating()) {
      return res.status(503).json({
        error: 'updating',
        message: 'Tool is updating — please wait. It restarts automatically; if the update fails, the tool resumes by itself.',
      })
    }
    const state = getState()
    if (!state.locked) return next()
    return res.status(503).json({
      error: 'version_locked',
      message: state.quarantined
        ? (state.quarantineMessage ?? 'This tool has been remotely paused by the administrator.')
        : state.lockMessage
          ?? `Tool disabled: version ${state.currentVersion} is behind the required minimum ${state.minVersion}. Update to continue.`,
      currentVersion: state.currentVersion,
      minVersion: state.minVersion,
      quarantined: state.quarantined,
    })
  }
}
