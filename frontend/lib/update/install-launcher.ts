import { spawn } from 'child_process'
import {
  fetchReleaseManifest,
  resolveUpdateScriptPath,
  compareVersions,
  getCurrentAppVersion,
  readLocalUpdateState,
  writeLocalUpdateState,
  isUpdateInProgress,
} from '@/lib/update/update-utils'
import { resolveUpdateStatePath } from '@/lib/storage-paths'

/**
 * Shared install pipeline (extracted from lib/heartbeat/command-handler.ts so
 * the cloud-pushed `update` command and the version-lock "Update now" route run
 * the EXACT same code — see FV-HARDENING-PLAN.md F7 and the drifted-copy
 * lessons in the sync outbox drains).
 *
 * The actual install is detached (spawned PowerShell, /S silent NSIS) and the
 * service restarts mid-flight, so `launched: true` is a LAUNCH ACK, not update
 * success — real success is the next heartbeat carrying the new version.
 */

export interface InstallLaunchOutcome {
  /** The pipeline started (or was a no-op because we're already up to date). */
  ok: boolean
  /** True only when the detached installer process was actually spawned. */
  launched: boolean
  message: string
}

export async function launchUpdateInstall(opts: {
  installerUrl?: string
  version?: string
  /** For the log line: who/what triggered this install. */
  trigger: string
}): Promise<InstallLaunchOutcome> {
  if (process.platform !== 'win32') {
    return { ok: false, launched: false, message: 'host-managed update is Windows-only' }
  }

  const scriptPath = resolveUpdateScriptPath()
  if (!scriptPath) {
    return { ok: false, launched: false, message: 'updater script not packaged on this host (portable build?)' }
  }

  // Refuse to stack updates — if one is GENUINELY in flight, wait for it rather
  // than fighting the running ps1 over the service control manager.
  // isUpdateInProgress() ignores a STALE non-terminal state (a dead/interrupted
  // prior run), so a poisoned status file doesn't permanently block retries.
  if (isUpdateInProgress()) {
    const live = readLocalUpdateState()
    return { ok: false, launched: false, message: `update already in progress (status=${live?.status ?? 'unknown'})` }
  }

  let installerUrl = opts.installerUrl?.trim() ?? ''
  let expectedVersion = opts.version?.trim() ?? ''

  // No pinned build → ask the manifest what's latest.
  if (!installerUrl || !expectedVersion) {
    const { manifest, error } = await fetchReleaseManifest()
    if (!manifest) {
      return { ok: false, launched: false, message: error || 'manifest fetch returned no version' }
    }
    if (!installerUrl) installerUrl = manifest.installerUrl
    if (!expectedVersion) expectedVersion = manifest.version
  }

  if (!/^https?:\/\//i.test(installerUrl)) {
    return { ok: false, launched: false, message: `installerUrl must be http(s): got "${installerUrl.slice(0, 80)}"` }
  }

  const currentVersion = getCurrentAppVersion()
  if (compareVersions(expectedVersion, currentVersion) <= 0) {
    // Requested version is what we're on (or older). Don't downgrade, don't
    // reinstall — acknowledge cleanly.
    return { ok: true, launched: false, message: `already on ${currentVersion} (>= requested ${expectedVersion})` }
  }

  // Stamp a fresh "checking" BEFORE spawning so the very next heartbeat
  // reflects this run rather than a previous update's success/error. The
  // ps1 overwrites this within a second via its own Write-State calls.
  writeLocalUpdateState({
    status: 'checking',
    message: `update triggered (${opts.trigger})`,
    version: expectedVersion,
    startedAt: new Date().toISOString(),
    installerUrl,
  })

  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        '-InstallerUrl', installerUrl,
        '-ExpectedVersion', expectedVersion,
        '-StatePath', resolveUpdateStatePath(),
      ],
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
    console.log(`[Update] install started (${opts.trigger}): ${currentVersion} → ${expectedVersion} (${installerUrl})`)
    return {
      ok: true,
      launched: true,
      message: `install launched ${currentVersion} -> ${expectedVersion}; track via heartbeat updateStatus`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, launched: false, message: `failed to spawn installer: ${msg}` }
  }
}
