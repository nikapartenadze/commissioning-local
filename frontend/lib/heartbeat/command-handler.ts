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

import { getMachineId } from './machine-id'
import { launchUpdateInstall } from '@/lib/update/install-launcher'

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
  const payload = (cmd.payload ?? {}) as { version?: unknown; installerUrl?: unknown }
  // The pipeline itself (platform/script/in-flight checks, manifest fallback,
  // no-downgrade gate, state stamp, detached spawn) lives in
  // lib/update/install-launcher.ts — shared with the version-lock "Update now"
  // route so the two triggers can never drift apart.
  const outcome = await launchUpdateInstall({
    installerUrl: typeof payload.installerUrl === 'string' ? payload.installerUrl : undefined,
    version: typeof payload.version === 'string' ? payload.version : undefined,
    trigger: 'cloud update command',
  })
  // NOTE: 'done' is a LAUNCH ACK (or a clean already-up-to-date no-op), not
  // update success. The installer runs detached and this process is replaced
  // when the service restarts. The cloud must judge real success from the
  // heartbeat-reported `version` + `updateStatus`
  // (see spec 2026-05-24-cloud-controlled-update-feedback).
  return {
    id: cmd.id,
    status: outcome.ok ? 'done' : 'failed',
    result: clampResult(outcome.message),
  }
}
