/**
 * Heartbeat Service
 *
 * Reports the laptop's identity + live system state to the cloud every
 * 30 s so operations has a fleet view. Best-effort: any failure (no
 * network, cloud down, 401/403) is logged and swallowed — the field
 * tool runs offline-first and must never crash because the cloud is
 * unreachable.
 *
 * Contract: see commissioning-cloud's POST /api/sync/heartbeat.
 *   - Auth: X-API-Key header (per-project apiKey from config.json)
 *   - Body: { machineId, hostname?, version?, currentUserEmail?,
 *            currentSubsystemId?, currentMcm?, systemInfo?,
 *            updateStatus?, commandResults? }
 *   - Response: { ok: true, commands: Array<{ id, type, payload }> }
 *
 * Commands flow: cloud may include pending commands in the response;
 * we execute them locally (see command-handler.ts), queue results
 * (command-queue.ts), and ship those results on the next heartbeat.
 */

import os from 'os'
import { configService } from '@/lib/config'
import { getCurrentAppVersion, getEffectiveUpdateState, type LocalUpdateState } from '@/lib/update/update-utils'
import { getMachineId } from './machine-id'
import { getRustDeskId } from './rustdesk-id'
import { collectSystemInfo, type HeartbeatSystemInfo } from './system-info'
import { executeCommand, type IncomingCommand, type CommandResult } from './command-handler'
import { drainResults, enqueueResult, requeue } from './command-queue'

const HEARTBEAT_TIMEOUT_MS = 10_000
const HEARTBEAT_PATH = '/api/sync/heartbeat'

export interface HeartbeatPayload {
  machineId: string
  hostname: string | null
  version: string | null
  currentUserEmail: string | null
  currentSubsystemId: number | null
  currentMcm: string | null
  systemInfo: HeartbeatSystemInfo
  // Last-known host-managed update state (the file install-update.ps1
  // writes). Lets the cloud fleet UI show the REAL update lifecycle
  // (downloading → installing → success|error) instead of the launch-ack
  // the command queue reports. Null when no update has ever run.
  updateStatus: LocalUpdateState | null
  // This laptop's RustDesk ID (from `rustdesk --get-id`), so the cloud fleet
  // view can show an authoritative one-click "Remote in" instead of guessing
  // by hostname. Omitted while unknown so the cloud keeps any prior value and
  // falls back to its hostname-based guess (see lib/heartbeat/rustdesk-id.ts).
  rustDeskId?: string
  commandResults?: CommandResult[]
  // B4: sync-queue depth so the fleet dashboard can spot a tablet silently
  // accumulating or PARKING unsynced field work — the MCM11 incident was
  // centrally invisible for days because the heartbeat carried no such signal.
  //   pendingSyncCount   — active retryable rows (IO + L2 queues)
  //   attentionSyncCount — PARKED rows (cloud-rejected / retry-cap): stuck,
  //                        not on cloud, needs a human. The number to alert on.
  pendingSyncCount?: number
  attentionSyncCount?: number
}

interface HeartbeatResponseBody {
  ok?: boolean
  commands?: IncomingCommand[]
}

/**
 * Build the JSON body that gets POSTed to the cloud. Exposed for
 * tests / diagnostics — production code should just call
 * sendHeartbeat().
 */
export async function buildHeartbeatPayload(): Promise<HeartbeatPayload> {
  const config = await configService.getConfig()

  const subsystemIdRaw = config.subsystemId
  let currentSubsystemId: number | null = null
  if (subsystemIdRaw) {
    const parsed = parseInt(String(subsystemIdRaw), 10)
    currentSubsystemId = Number.isFinite(parsed) ? parsed : null
  }

  const rustDeskId = getRustDeskId()

  // B4 sync-queue depth (best-effort; never let it break the heartbeat).
  let pendingSyncCount: number | undefined
  let attentionSyncCount: number | undefined
  try {
    const { db } = await import('@/lib/db-sqlite')
    const io = (db.prepare('SELECT COUNT(*) c FROM PendingSyncs WHERE DeadLettered = 0').get() as { c: number }).c
    let l2 = 0
    try { l2 = (db.prepare('SELECT COUNT(*) c FROM L2PendingSyncs').get() as { c: number }).c } catch { /* table may not exist */ }
    pendingSyncCount = io + l2
    attentionSyncCount = (db.prepare('SELECT COUNT(*) c FROM PendingSyncs WHERE DeadLettered = 1').get() as { c: number }).c
  } catch { /* DB not ready — omit, cloud keeps prior value */ }

  return {
    machineId: getMachineId(),
    hostname: os.hostname() || null,
    version: getCurrentAppVersion() || null,
    pendingSyncCount,
    attentionSyncCount,
    // TODO: server-side has no clean read on the active operator. The
    // JWT (lib/auth/jwt.ts) carries fullName but not email, and the
    // canonical identity lives in browser localStorage via
    // lib/user-context.tsx. Sending null until the auth model exposes
    // an email on the server side (e.g. by storing it in the JWT
    // payload and threading it through a server-held "active session"
    // map keyed off machineId).
    currentUserEmail: null,
    currentSubsystemId,
    // TODO: there is no first-class "currentMcm" in config.json — MCM
    // identity is encoded in PlcProfile.name but the active profile
    // isn't recorded anywhere. Leaving null until we add an active-
    // profile pointer to config or derive it from subsystemId.
    currentMcm: null,
    systemInfo: collectSystemInfo(),
    // getEffectiveUpdateState swallows read/parse errors → null, and downgrades
    // a STALE non-terminal state to `error` so the cloud banner stops reporting
    // a phantom "installing…" for a tablet whose updater died mid-flight.
    updateStatus: getEffectiveUpdateState(),
    // Non-blocking: null on the first tick after startup, then the real ID
    // once the background probe resolves. Spread so it's omitted (not sent as
    // null) while unknown — the cloud only overwrites its stored ID when the
    // key is present, so this never wipes a previously-reported value.
    ...(rustDeskId ? { rustDeskId } : {}),
  }
}

/**
 * Fire a single heartbeat. Never throws, never blocks longer than
 * HEARTBEAT_TIMEOUT_MS.
 */
export async function sendHeartbeat(): Promise<void> {
  let payload: HeartbeatPayload
  try {
    payload = await buildHeartbeatPayload()
  } catch (err) {
    console.warn('[Heartbeat] Failed to build payload:', err instanceof Error ? err.message : err)
    return
  }

  let remoteUrl: string
  let apiKey: string
  try {
    const config = await configService.getConfig()
    remoteUrl = (config.remoteUrl || '').replace(/\/$/, '')
    apiKey = config.apiPassword || ''
  } catch (err) {
    console.warn('[Heartbeat] Failed to load config:', err instanceof Error ? err.message : err)
    return
  }

  if (!remoteUrl) {
    // Nothing to talk to — silent skip.
    return
  }
  if (!apiKey) {
    // Without an apiKey the cloud will 401. Don't burn cycles on it.
    return
  }

  // Attach any results queued since the last successful heartbeat.
  // Drained eagerly so they're cleared from the queue; if the POST
  // fails below we requeue() them so they retry next tick.
  const drained = drainResults()
  if (drained.length > 0) {
    payload.commandResults = drained
  }

  let resp: Response
  try {
    resp = await fetch(`${remoteUrl}${HEARTBEAT_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    })
  } catch (err) {
    // Network error, timeout, DNS failure — fine, we'll try again on
    // the next tick. Put any drained results back so they ship then.
    requeue(drained)
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED') && !msg.includes('aborted')) {
      console.warn(`[Heartbeat] Send error: ${msg}`)
    }
    return
  }

  if (!resp.ok) {
    // 401/403 likely means apiKey changed or project was deleted;
    // 5xx means cloud is having a moment. The drained results never
    // made it to durable storage — requeue so they retry next tick.
    requeue(drained)
    console.warn(`[Heartbeat] Cloud responded ${resp.status}`)
    return
  }

  // Response handling is best-effort: a malformed body or a misbehaving
  // command executor must never crash the heartbeat loop.
  try {
    const body = (await resp.json()) as HeartbeatResponseBody
    const commands = Array.isArray(body?.commands) ? body.commands : []
    if (commands.length === 0) return

    // ping is fast; parallelizing keeps the loop snappy even if a
    // future command type sneaks in a small await. allSettled because
    // executeCommand() already swallows errors, but defense in depth.
    const results = await Promise.allSettled(commands.map((cmd) => executeCommand(cmd)))
    for (const r of results) {
      if (r.status === 'fulfilled') {
        enqueueResult(r.value)
      } else {
        // executeCommand is designed not to reject, but if it ever
        // does we still want to give the cloud some feedback.
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
        console.warn(`[Heartbeat] executeCommand rejected: ${msg}`)
      }
    }
  } catch (err) {
    console.warn(
      '[Heartbeat] Failed to handle response:',
      err instanceof Error ? err.message : err,
    )
  }
}

let loopTimer: NodeJS.Timeout | null = null

/**
 * Start a standalone heartbeat loop. Most callers should instead let
 * auto-sync.ts piggyback on its existing 30 s pushTimer (one timer,
 * one log line per cycle). This is here for callers that want an
 * independent loop (e.g. unit tests, scripts).
 */
export function startHeartbeatLoop(intervalMs = 30_000): void {
  if (loopTimer) return
  // Fire immediately so a freshly-started tool reports in right away.
  void sendHeartbeat()
  loopTimer = setInterval(() => { void sendHeartbeat() }, intervalMs)
}

export function stopHeartbeatLoop(): void {
  if (loopTimer) {
    clearInterval(loopTimer)
    loopTimer = null
  }
}
