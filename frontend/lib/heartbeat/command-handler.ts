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

import { spawnSync } from 'child_process'
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

      // ── Remote ops batch (2026-07-12) ─────────────────────────────────────
      case 'restart': {
        return handleRestartCommand(cmd)
      }

      case 'force-sync': {
        return await handleForceSyncCommand(cmd)
      }

      case 'set-config': {
        return await handleSetConfigCommand(cmd)
      }

      case 'upload-journals': {
        return await handleUploadJournalsCommand(cmd)
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
  const payload = (cmd.payload ?? {}) as { version?: unknown; installerUrl?: unknown; sha256?: unknown }
  // The pipeline itself (platform/script/in-flight checks, manifest fallback,
  // URL transport policy, sha256 integrity plumbing, no-downgrade gate, state
  // stamp, detached spawn) lives in lib/update/install-launcher.ts — shared
  // with the version-lock "Update now" route so the two triggers can never
  // drift apart. `sha256` (optional, new clouds only) rides along with a
  // pinned installerUrl so the ps1 can verify the download before running it.
  const outcome = await launchUpdateInstall({
    installerUrl: typeof payload.installerUrl === 'string' ? payload.installerUrl : undefined,
    version: typeof payload.version === 'string' ? payload.version : undefined,
    sha256: typeof payload.sha256 === 'string' ? payload.sha256 : undefined,
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

// ── Remote ops batch (2026-07-12) ──────────────────────────────────────────

/** True when the tool runs as the NSSM Windows service (auto-restarts on exit). */
function isServiceMode(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const r = spawnSync('sc', ['query', 'CommissioningTool'], { timeout: 5000, encoding: 'utf8' })
    return r.status === 0 && /RUNNING|START_PENDING/.test(r.stdout ?? '')
  } catch {
    return false
  }
}

/**
 * Clean restart. ONLY valid under the NSSM service (AppExit Restart relaunches
 * us); a portable install would just die and stay down, so it refuses. The
 * exit is DELAYED past the next heartbeat tick so the 'done' ack ships first.
 */
function handleRestartCommand(cmd: IncomingCommand): CommandResult {
  if (!isServiceMode()) {
    return {
      id: cmd.id,
      status: 'failed',
      result: 'not running as the CommissioningTool service (portable mode?) — a restart would stay down; restart on the box instead',
    }
  }
  const DELAY_MS = 25_000 // > heartbeat tick, so the ack reaches the cloud first
  console.warn(`[Command] restart requested from cloud — exiting in ${DELAY_MS / 1000}s (NSSM relaunches)`)
  const t = setTimeout(() => process.exit(0), DELAY_MS)
  t.unref?.()
  return { id: cmd.id, status: 'done', result: `restarting in ${DELAY_MS / 1000}s (service auto-relaunch)` }
}

/**
 * Unpark the four non-IO queues (L2/e-stop/guided/blocker) and kick an
 * immediate push drain. IO rows stay operator-gated via push-force by design —
 * force-writing IO results past the version gate needs a human decision.
 */
async function handleForceSyncCommand(cmd: IncomingCommand): Promise<CommandResult> {
  try {
    const { db } = await import('@/lib/db-sqlite')
    const { auditLog } = await import('@/lib/logging/recovery-log')
    const tables = ['L2PendingSyncs', 'EStopCheckPendingSyncs', 'GuidedTaskStatePendingSyncs', 'DeviceBlockerPendingSyncs']
    let unparked = 0
    for (const t of tables) {
      try {
        // Clearing Resolved is required, not cosmetic: an un-parked row that
        // stays Resolved is filtered out of every active-queue read, so the
        // force-sync would report rows unparked that can never actually drain.
        const r = db.prepare(
          `UPDATE ${t} SET DeadLettered = 0, Resolved = 0, ResolvedAt = NULL, ResolvedReason = NULL, RetryCount = 0 WHERE DeadLettered = 1`,
        ).run()
        unparked += r.changes
      } catch { /* table missing on old DB */ }
    }
    if (unparked > 0) {
      auditLog({ type: 'sync.reconcile.enqueue', reason: `cloud force-sync command unparked ${unparked} row(s)`, detail: { commandId: cmd.id } })
    }
    try {
      const { getAutoSyncService } = await import('@/lib/cloud/auto-sync')
      getAutoSyncService()?.kickPush()
    } catch { /* push tick will pick the rows up anyway */ }
    return { id: cmd.id, status: 'done', result: `unparked ${unparked} row(s) (L2/e-stop/guided/blocker) + push kicked; IO parks need push-force on the box` }
  } catch (err) {
    return { id: cmd.id, status: 'failed', result: clampResult(`force-sync failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
}

/**
 * Remote subsystem reassignment for a SINGLE-MCM tablet (the "walking back and
 * forth to fix a wrong assignment" case). Central boxes refuse — their MCM
 * list is managed on the box and a blind swap could disconnect live MCMs.
 */
async function handleSetConfigCommand(cmd: IncomingCommand): Promise<CommandResult> {
  const payload = (cmd.payload ?? {}) as { subsystemId?: unknown }
  const sid = typeof payload.subsystemId === 'number' && Number.isInteger(payload.subsystemId) && payload.subsystemId > 0
    ? payload.subsystemId
    : null
  if (!sid) return { id: cmd.id, status: 'failed', result: 'set-config requires payload.subsystemId (positive integer)' }
  try {
    const { configService } = await import('@/lib/config')
    if (process.env.PLC_MODE === 'remote' || (await configService.getMcms()).length > 0) {
      return { id: cmd.id, status: 'failed', result: 'central/multi-MCM box — manage the MCM list on the box, not via set-config' }
    }
    const before = String((await configService.getConfig()).subsystemId ?? '')
    await configService.saveConfig({ subsystemId: String(sid) })
    const { auditLog } = await import('@/lib/logging/recovery-log')
    auditLog({ type: 'config.remote', reason: 'cloud set-config command', detail: { commandId: cmd.id, subsystemId: { from: before, to: String(sid) } } })
    return { id: cmd.id, status: 'done', result: `subsystemId ${before || '(unset)'} -> ${sid}` }
  } catch (err) {
    return { id: cmd.id, status: 'failed', result: clampResult(`set-config failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
}

/** Ship the recovery journal to the cloud NOW (same uploader as the 6 h timer). */
async function handleUploadJournalsCommand(cmd: IncomingCommand): Promise<CommandResult> {
  try {
    const { runJournalUpload } = await import('@/lib/cloud/journal-uploader')
    await runJournalUpload()
    return { id: cmd.id, status: 'done', result: 'journal upload run completed (see cloud /api/sync/journal store)' }
  } catch (err) {
    return { id: cmd.id, status: 'failed', result: clampResult(`journal upload failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
}
