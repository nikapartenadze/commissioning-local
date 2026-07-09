import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'
import { writeOutputBitBySubsystem, type IoBitResult } from '@/lib/mcm-registry'

/**
 * POST /api/safety/fire
 * Body: { tag, action, subsystemId? }
 *
 * Fires a STD_ safety intermediary bit. When `subsystemId` is supplied (central
 * server / split deployment) the write is routed to that MCM via the mode-aware
 * facade (embedded in-process, remote → plc-gateway). Without it, falls back to
 * the legacy singleton (single-MCM field tablet, embedded only).
 */
export async function POST(req: Request, res: Response) {
  try {
    const { tag, action, subsystemId } = req.body

    if (!tag || typeof tag !== 'string') return res.status(400).json({ success: false, error: 'tag is required' })
    if (!tag.startsWith('STD_')) return res.status(400).json({ success: false, error: 'Only STD_ intermediary tags can be fired' })

    const bitValue: number | 'toggle' = action === 'toggle' ? 'toggle' : (action === 'stop' ? 0 : 1)

    let result: IoBitResult
    if (subsystemId !== undefined && subsystemId !== null && subsystemId !== '') {
      result = await writeOutputBitBySubsystem(String(subsystemId), { id: -1, name: tag }, bitValue)
    } else {
      const client = getPlcClient()
      const r = client.isConnected
        ? client.writeOutputBit({ id: -1, name: tag }, bitValue)
        : { success: false, error: 'PLC not connected' }
      result = { connected: client.isConnected, success: r.success, currentState: r.currentState, error: r.error }
    }

    if (!result.connected) {
      return res.status(503).json({ success: false, error: subsystemId ? `PLC for MCM ${subsystemId} not connected` : 'PLC not connected' })
    }
    if (!result.success) return res.status(500).json({ success: false, error: result.error })

    const newState = action === 'toggle' ? !result.currentState : action !== 'stop'
    return res.json({ success: true, tag, state: newState })
  } catch (error) {
    // Safety-critical write: leave a diagnostic trail behind the generic client
    // message so a failed STD_ intermediary fire isn't silently swallowed.
    console.error('[SafetyFire] Error firing safety output:', error)
    return res.status(500).json({ success: false, error: 'Failed to fire safety output' })
  }
}
