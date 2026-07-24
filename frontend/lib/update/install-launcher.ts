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
import { isValidSha256, validateInstallerUrl, envAllowsHttp } from '@/lib/update/integrity'

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
  /**
   * Hex SHA-256 of the installer at installerUrl. When present the ps1
   * verifies the download and refuses to run on mismatch. Only paired with a
   * caller-supplied installerUrl; when the URL comes from the manifest, the
   * manifest's own sha256 is used instead (a hash must always describe the
   * exact file it rode in with).
   */
  sha256?: string
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

  const callerPinnedUrl = !!opts.installerUrl?.trim()
  let installerUrl = opts.installerUrl?.trim() ?? ''
  let expectedVersion = opts.version?.trim() ?? ''
  let sha256 = opts.sha256?.trim() ?? ''

  // No pinned build → ask the manifest what's latest.
  if (!installerUrl || !expectedVersion) {
    const { manifest, error } = await fetchReleaseManifest()
    if (!manifest) {
      return { ok: false, launched: false, message: error || 'manifest fetch returned no version' }
    }
    if (!installerUrl) installerUrl = manifest.installerUrl
    if (!expectedVersion) expectedVersion = manifest.version
    // Only adopt the manifest's hash when the URL is ALSO the manifest's —
    // pairing the manifest hash with a caller-pinned URL would guarantee a
    // false mismatch (or worse, mask which file was actually pinned).
    if (!callerPinnedUrl && !sha256 && typeof manifest.sha256 === 'string') {
      sha256 = manifest.sha256.trim()
    }
  }

  // Transport policy: https required except loopback; plain http for other
  // hosts only behind the explicit UPDATE_ALLOW_HTTP opt-in (battle/soak rigs
  // and LAN test clouds — see lib/update/integrity.ts).
  const urlPolicy = validateInstallerUrl(installerUrl, { allowHttp: envAllowsHttp(process.env.UPDATE_ALLOW_HTTP) })
  if (!urlPolicy.ok) {
    return { ok: false, launched: false, message: urlPolicy.reason ?? 'installerUrl rejected by transport policy' }
  }

  // A malformed hash is refused outright (fail closed) — silently dropping it
  // would downgrade a "verify this exact file" instruction to an unverified
  // install without anyone noticing.
  if (sha256 && !isValidSha256(sha256)) {
    return { ok: false, launched: false, message: `sha256 must be 64 hex chars: got "${sha256.slice(0, 80)}"` }
  }
  if (!sha256) {
    // Old cloud (manifest/command without sha256): allowed, but loudly — this
    // is the backward-compat window, not the end state.
    console.warn(`[Update] WARNING: no sha256 available for ${installerUrl} — installer integrity will NOT be verified (cloud predates integrity manifest?)`)
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
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-InstallerUrl', installerUrl,
      '-ExpectedVersion', expectedVersion,
      '-StatePath', resolveUpdateStatePath(),
    ]
    // Verified path: the ps1 Get-FileHash-checks the download and hard-fails
    // (no installer run) on mismatch. Omitted entirely when unknown so an old
    // ps1 (pre-integrity packaged copy) never sees an unknown parameter.
    if (sha256) psArgs.push('-Sha256', sha256)
    const child = spawn(
      'powershell.exe',
      psArgs,
      { detached: true, stdio: 'ignore' },
    )
    child.unref()
    console.log(`[Update] install started (${opts.trigger}): ${currentVersion} → ${expectedVersion} (${installerUrl}) integrity=${sha256 ? `sha256:${sha256.slice(0, 12)}…` : 'UNVERIFIED'}`)
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
