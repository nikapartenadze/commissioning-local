import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'
import { writeOutputBitBySubsystem, type IoBitResult } from '@/lib/mcm-registry'

// key: `${subsystemId|'_'}:${bssTag}` so the same BSS tag on different MCMs
// holds independently.
const activeBypass: Map<string, NodeJS.Timeout> =
  ((globalThis as any).__activeBypass ??= new Map<string, NodeJS.Timeout>())

function keyFor(subsystemId: string | undefined, bssTag: string): string {
  return `${subsystemId || '_'}:${bssTag}`
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
  const r = client.writeOutputBit({ id: -1, name: bssTag }, value)
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
      const interval = setInterval(async () => {
        if (writing) return
        writing = true
        try {
          const r = await writeBypassBit(subsystemId, bssTag, 1)
          if (!r.connected) { clearInterval(interval); activeBypass.delete(key) }
        } catch {
          clearInterval(interval); activeBypass.delete(key)
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
    return res.status(500).json({ success: false, error: 'Failed to control bypass' })
  }
}

export async function GET(_req: Request, res: Response) {
  // Strip the subsystem prefix for backward-compatible display.
  const active = Array.from(activeBypass.keys()).map((k) => k.slice(k.indexOf(':') + 1))
  return res.json({ success: true, active })
}
