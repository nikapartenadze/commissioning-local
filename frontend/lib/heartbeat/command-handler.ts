/**
 * Heartbeat Command Handler
 *
 * Pure dispatcher for commands that arrive in a heartbeat response.
 * The cloud's POST /api/sync/heartbeat body includes a `commands` array;
 * v1 handled `ping` only. v2 (this revision) adds `update`, which lets
 * an admin push a remote install from the cloud assets page. Unknown
 * command types are logged and reported back as `failed` so the cloud
 * operator sees they were delivered but unsupported.
 *
 * Design rules:
 *   - Never throw. A misbehaving command must not propagate into the
 *     heartbeat loop or the auto-sync tick.
 *   - Cheap and synchronous-ish for fast commands (ping). The `update`
 *     command is fire-and-forget: it kicks off the install pipeline
 *     (which runs detached in a separate PowerShell process), reports
 *     'done' as soon as the pipeline starts, then the service restarts
 *     and the heartbeat loop is replaced wholesale by the new build.
 */

import { spawn } from 'child_process'
import { getMachineId } from './machine-id'
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

export interface IncomingCommand {
  id: number
  type: 'ping' | string
  payload: unknown | null
}

export interface CommandResult {
  id: number
  status: 'done' | 'failed'
  result?: string
}

const RESULT_MAX_LEN = 2000

function clampResult(s: string): string {
  if (s.length <= RESULT_MAX_LEN) return s
  return s.slice(0, RESULT_MAX_LEN)
}

function machineIdSuffix(): string {
  try {
    const id = getMachineId()
    return id.slice(-8)
  } catch {
    return 'unknown'
  }
}

/**
 * Execute a single command. Always resolves — errors are caught and
 * reported as `failed` results so the cloud sees the outcome.
 */
export async function executeCommand(cmd: IncomingCommand): Promise<CommandResult> {
  try {
    switch (cmd.type) {
      case 'ping': {
        const payload = (cmd.payload ?? {}) as { message?: unknown }
        const message = typeof payload.message === 'string' ? payload.message : ''
        console.log(`[Command] ping received: ${message}`)
        return {
          id: cmd.id,
          status: 'done',
          result: clampResult(`pong (machineId=${machineIdSuffix()})`),
        }
      }

      case 'update': {
        return await handleUpdateCommand(cmd)
      }

      default: {
        console.warn(`[Command] Unknown command type: ${cmd.type} (id=${cmd.id})`)
        return {
          id: cmd.id,
          status: 'failed',
          result: clampResult(`unknown command type: ${cmd.type}`),
        }
      }
    }
  } catch (err) {
    // Defensive belt-and-braces — the per-case bodies above shouldn't
    // throw, but if a future command type does, we still want a clean
    // failed result rather than an unhandled rejection in the loop.
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[Command] Executor threw for id=${cmd.id} type=${cmd.type}: ${msg}`)
    return {
      id: cmd.id,
      status: 'failed',
      result: clampResult(`executor error: ${msg}`),
    }
  }
}

/**
 * Cloud-pushed remote install.
 *
 * Payload shape (all optional):
 *   { version?: string, installerUrl?: string }
 *
 * When `installerUrl` is supplied, the install pipeline uses it directly
 * — letting the cloud target a specific version regardless of what the
 * manifest currently advertises. When both are absent we fall through to
 * the configured manifest (same code path as the in-app "Install on Host"
 * button), so the simplest UX from the cloud side is to just push an
 * empty `update` and let the manifest decide.
 *
 * The actual install is detached (spawned PowerShell, /S silent NSIS)
 * and the service restarts mid-flight. By the time the heartbeat loop
 * sees the next tick, this process is gone and a new build has taken
 * over. We therefore report 'done' once the pipeline has been *started*
 * — the cloud's signal that the install actually worked is the next
 * heartbeat carrying the new `version` field.
 */
async function handleUpdateCommand(cmd: IncomingCommand): Promise<CommandResult> {
  if (process.platform !== 'win32') {
    return {
      id: cmd.id,
      status: 'failed',
      result: 'host-managed update is Windows-only',
    }
  }

  const scriptPath = resolveUpdateScriptPath()
  if (!scriptPath) {
    return {
      id: cmd.id,
      status: 'failed',
      result: 'updater script not packaged on this host (portable build?)',
    }
  }

  // Refuse to stack updates — if one is GENUINELY in flight, this command
  // waits for the next heartbeat after restart rather than fighting the
  // running ps1 over the service control manager. isUpdateInProgress()
  // ignores a STALE non-terminal state (a dead/interrupted prior run), so a
  // poisoned status file no longer permanently blocks fresh cloud retries.
  if (isUpdateInProgress()) {
    const live = readLocalUpdateState()
    return {
      id: cmd.id,
      status: 'failed',
      result: `update already in progress (status=${live?.status ?? 'unknown'})`,
    }
  }

  const payload = (cmd.payload ?? {}) as { version?: unknown; installerUrl?: unknown }
  let installerUrl = typeof payload.installerUrl === 'string' ? payload.installerUrl.trim() : ''
  let expectedVersion = typeof payload.version === 'string' ? payload.version.trim() : ''

  // If the cloud didn't pin a specific build, ask the manifest. This is
  // the common path — the cloud admin just clicks "Push update" without
  // specifying anything and we install whatever the manifest says is
  // latest.
  if (!installerUrl || !expectedVersion) {
    const { manifest, error } = await fetchReleaseManifest()
    if (!manifest) {
      return {
        id: cmd.id,
        status: 'failed',
        result: clampResult(error || 'manifest fetch returned no version'),
      }
    }
    if (!installerUrl) installerUrl = manifest.installerUrl
    if (!expectedVersion) expectedVersion = manifest.version
  }

  if (!/^https?:\/\//i.test(installerUrl)) {
    return {
      id: cmd.id,
      status: 'failed',
      result: `installerUrl must be http(s): got "${installerUrl.slice(0, 80)}"`,
    }
  }

  const currentVersion = getCurrentAppVersion()
  if (compareVersions(expectedVersion, currentVersion) <= 0) {
    // Cloud pushed a version we're already on (or older). Don't downgrade,
    // don't reinstall — just acknowledge so the command queue clears.
    return {
      id: cmd.id,
      status: 'done',
      result: `already on ${currentVersion} (>= requested ${expectedVersion})`,
    }
  }

  // Stamp a fresh "checking" BEFORE spawning so the very next heartbeat
  // reflects this run rather than a previous update's success/error. The
  // ps1 overwrites this within a second via its own Write-State calls.
  writeLocalUpdateState({
    status: 'checking',
    message: 'update command received from cloud',
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
    console.log(`[Command] update started: ${currentVersion} → ${expectedVersion} (${installerUrl})`)
    // NOTE: 'done' here is a LAUNCH ACK, not update success. The installer
    // runs detached and this process is replaced when the service restarts.
    // The cloud must judge real success from the heartbeat-reported
    // `version` + `updateStatus` (see spec 2026-05-24-cloud-controlled-update-feedback).
    return {
      id: cmd.id,
      status: 'done',
      result: clampResult(`install launched ${currentVersion} -> ${expectedVersion}; track via heartbeat updateStatus`),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      id: cmd.id,
      status: 'failed',
      result: clampResult(`failed to spawn installer: ${msg}`),
    }
  }
}
