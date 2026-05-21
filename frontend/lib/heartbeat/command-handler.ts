/**
 * Heartbeat Command Handler
 *
 * Pure dispatcher for commands that arrive in a heartbeat response.
 * The cloud's POST /api/sync/heartbeat body now includes a `commands`
 * array; for v1 we only meaningfully handle `ping`. Unknown command
 * types are logged and reported back as `failed` so the cloud operator
 * sees they were delivered but unsupported.
 *
 * Design rules:
 *   - Never throw. A misbehaving command must not propagate into the
 *     heartbeat loop or the auto-sync tick.
 *   - Cheap and synchronous-ish. `ping` does no IO. Future command
 *     types (e.g. `update`) will need their own design re: long-running
 *     work and >30s execution windows.
 */

import { getMachineId } from './machine-id'

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
