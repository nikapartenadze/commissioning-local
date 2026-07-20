import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'
import { writeOutputBitBySubsystem, type IoBitResult } from '@/lib/mcm-registry'
import { getBroadcastUrl } from '@/lib/broadcast-config'

// key: `${subsystemId|'_'}:${bssTag}` so the same BSS tag on different MCMs
// holds independently.
const activeBypass: Map<string, NodeJS.Timeout> =
  ((globalThis as any).__activeBypass ??= new Map<string, NodeJS.Timeout>())

function keyFor(subsystemId: string | undefined, bssTag: string): string {
  return `${subsystemId || '_'}:${bssTag}`
}

/**
 * Notify browsers that a bypass keep-alive was torn down server-side (PLC
 * disconnect or repeated write failure) AFTER the client already got
 * `200 {active:true}`. Without this the operator's screen keeps showing
 * "BYPASS ACTIVE" while the bit is no longer held. Best-effort — the bridge may
 * be momentarily down; the client's active-bypass poll is the durable fallback.
 */
async function broadcastBypassEnded(
  subsystemId: string | undefined,
  bssTag: string,
  reason: string,
): Promise<void> {
  try {
    await fetch(getBroadcastUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'BypassEnded',
        bssTag,
        subsystemId: subsystemId ?? null,
        reason,
      }),
    })
  } catch { /* best-effort — client also polls the active-bypass list */ }
}

/** Write the bypass bit to the right MCM (facade) or the legacy singleton. */
async function writeBypassBit(
  subsystemId: string | undefined,
  bssTag: string,
  value: number
): Promise<IoBitResult> {
  if (subsystemId !== undefined && subsystemId !== null && String(subsystemId) !== '') {
    return writeOutputBitBySubsystem(String(subsystemId), { id: -1, name: bssTag }, value)
  }
  const client = getPlcClient()
  if (!client.isConnected) return { connected: false, success: false, error: 'PLC not connected' }
  const r = await client.writeOutputBit({ id: -1, name: bssTag }, value)
  return { connected: true, success: r.success, currentState: r.currentState, error: r.error }
}

/**
 * POST /api/safety/bypass  Body: { bssTag, action, subsystemId? }
 *
 * Holds a BSS bypass bit TRUE with a 500ms keep-alive while active. MCM-aware
 * when subsystemId is supplied (central server / split); legacy singleton
 * otherwise.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { bssTag, action, subsystemId } = req.body

    if (!bssTag || typeof bssTag !== 'string') {
      return res.status(400).json({ success: false, error: 'bssTag is required' })
    }

    const key = keyFor(subsystemId, bssTag)

    if (action === 'start') {
      // Replace any existing keep-alive SYNCHRONOUSLY and register the new
      // interval BEFORE any await, so two near-simultaneous starts for the same
      // key can't leak an untracked interval (which would hold the bypass bit
      // forever with no way to stop it from the API).
      const existing = activeBypass.get(key)
      if (existing) clearInterval(existing)

      let writing = false // single-flight: never stack keep-alive writes on a slow gateway
      // A SINGLE transient keep-alive failure used to tear the bypass down with
      // no notice — the safety bit dropped while the operator's screen still
      // read "active." Tolerate a couple of consecutive failures (a slow/blipping
      // gateway) and only give up — then broadcast BypassEnded + log — on a real
      // disconnect or a sustained failure run. Any success resets the counter.
      let consecutiveFailures = 0
      const MAX_KEEPALIVE_FAILURES = 3 // ~1.5s of failed 500ms writes before giving up
      let interval: NodeJS.Timeout
      const teardown = (reason: string) => {
        clearInterval(interval)
        activeBypass.delete(key)
        console.error(`[SafetyBypass] Keep-alive ENDED on ${bssTag}${subsystemId ? ` (MCM ${subsystemId})` : ''}: ${reason}`)
        void broadcastBypassEnded(subsystemId, bssTag, reason)
      }
      interval = setInterval(async () => {
        if (writing) return
        writing = true
        try {
          const r = await writeBypassBit(subsystemId, bssTag, 1)
          if (r.connected && r.success) {
            consecutiveFailures = 0
          } else if (!r.connected) {
            // A genuine disconnect ends immediately — retrying a dead PLC is
            // pointless and the operator must be told the bit is no longer held.
            teardown('PLC disconnected')
          } else {
            consecutiveFailures++
            if (consecutiveFailures >= MAX_KEEPALIVE_FAILURES) {
              teardown(`write failed ${consecutiveFailures}x: ${r.error || 'unknown'}`)
            }
          }
        } catch (err) {
          consecutiveFailures++
          if (consecutiveFailures >= MAX_KEEPALIVE_FAILURES) {
            teardown(`keep-alive threw ${consecutiveFailures}x: ${err instanceof Error ? err.message : String(err)}`)
          }
        } finally {
          writing = false
        }
      }, 500)
      activeBypass.set(key, interval)

      // First write — surfaces connect/permission errors. Tear down on failure.
      const result = await writeBypassBit(subsystemId, bssTag, 1)
      if (!result.connected) {
        clearInterval(interval); activeBypass.delete(key)
        return res.status(503).json({ success: false, error: subsystemId ? `PLC for MCM ${subsystemId} not connected` : 'PLC not connected' })
      }
      if (!result.success) {
        clearInterval(interval); activeBypass.delete(key)
        return res.status(500).json({ success: false, error: result.error })
      }
      console.log(`[SafetyBypass] STARTED bypass on ${bssTag}${subsystemId ? ` (MCM ${subsystemId})` : ''}`)
      return res.json({ success: true, bssTag, active: true })
    }

    if (action === 'stop') {
      if (activeBypass.has(key)) { clearInterval(activeBypass.get(key)!); activeBypass.delete(key) }
      try { await writeBypassBit(subsystemId, bssTag, 0) } catch { /* best-effort */ }
      console.log(`[SafetyBypass] STOPPED bypass on ${bssTag}${subsystemId ? ` (MCM ${subsystemId})` : ''}`)
      return res.json({ success: true, bssTag, active: false })
    }

    return res.status(400).json({ success: false, error: 'action must be start or stop' })
  } catch (error) {
    // Safety-critical write: leave a diagnostic trail behind the generic client
    // message so a failed BSS bypass control isn't silently swallowed.
    console.error('[SafetyBypass] Error controlling bypass:', error)
    return res.status(500).json({ success: false, error: 'Failed to control bypass' })
  }
}

export async function GET(_req: Request, res: Response) {
  // Strip the subsystem prefix for backward-compatible display.
  const active = Array.from(activeBypass.keys()).map((k) => k.slice(k.indexOf(':') + 1))
  return res.json({ success: true, active })
}
