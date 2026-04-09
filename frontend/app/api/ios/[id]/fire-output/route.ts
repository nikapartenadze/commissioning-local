import { Request, Response } from 'express'
import { getPlcClient, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'

/**
 * POST /api/ios/:id/fire-output
 */
export async function POST(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string, 10)

    if (isNaN(ioId)) {
      return res.status(400).json({ success: false, error: 'Invalid IO ID' })
    }

    let action: 'start' | 'stop' | 'toggle' = 'start'
    try {
      if (req.body && req.body.action === 'stop') {
        action = 'stop'
      } else if (req.body && req.body.action === 'toggle') {
        action = 'toggle'
      }
    } catch {
      // No body or invalid JSON - default to 'start'
    }

    console.log(`[FireOutput] IO ${ioId}: ${action}`)

    const io = db.prepare('SELECT id, Name, TagType FROM Ios WHERE id = ?').get(ioId) as Pick<Io, 'id' | 'Name' | 'TagType'> | undefined

    if (!io) {
      return res.status(404).json({ success: false, error: 'IO not found' })
    }

    if (!io.Name) {
      return res.status(400).json({ success: false, error: 'IO has no tag name' })
    }

    if (io.Name.includes(':SO.')) {
      return res.status(400).json({
        success: false,
        error: 'Safety outputs cannot be fired directly - they are controlled by the safety PLC'
      })
    }

    const client = getPlcClient()

    if (!client.isConnected) {
      return res.status(503).json({ success: false, error: 'PLC not connected' })
    }

    const bitValue: number | 'toggle' = action === 'toggle' ? 'toggle' : (action === 'start' ? 1 : 0)

    const result = client.writeOutputBit(
      { id: io.id, name: io.Name, tagType: io.TagType ?? undefined },
      bitValue
    )

    if (!result.success) {
      console.error(`[FireOutput] Failed to ${action} output:`, result.error)
      return res.status(500).json({ success: false, error: result.error || `Failed to ${action} output` })
    }

    let newState: boolean
    if (action === 'toggle') {
      newState = !result.currentState
    } else {
      newState = action === 'start'
    }

    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'UpdateState',
          id: ioId,
          state: newState
        })
      })
    } catch {
      // WebSocket server might not be running
    }

    console.log(`[FireOutput] IO ${ioId} ${newState ? 'ON' : 'OFF'}`)

    return res.json({
      success: true,
      action,
      ioId,
      state: newState,
      message: `Output ${newState ? 'ON' : 'OFF'}`
    })
  } catch (error) {
    console.error('[FireOutput] Error:', error)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to control output'
    })
  }
}
