import { Request, Response } from 'express'
import { getPlcClient, getWsBroadcastUrl } from '@/lib/plc-client-manager'
import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'

/**
 * GET /api/ios/:id/state
 */
export async function GET(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.id as string, 10)

    if (isNaN(ioId)) {
      return res.status(400).json({ success: false, error: 'Invalid IO ID' })
    }

    const io = db.prepare('SELECT id, Name, TagType FROM Ios WHERE id = ?').get(ioId) as Pick<Io, 'id' | 'Name' | 'TagType'> | undefined

    if (!io || !io.Name) {
      return res.status(404).json({ success: false, error: 'IO not found' })
    }

    const client = getPlcClient()

    if (!client.isConnected) {
      return res.status(503).json({ success: false, error: 'PLC not connected' })
    }

    const readResult = client.readOutputBit({
      id: io.id,
      name: io.Name,
      tagType: io.TagType ?? undefined
    })

    if (!readResult.success) {
      return res.status(500).json({ success: false, error: readResult.error || 'Failed to read tag' })
    }

    const state = readResult.currentState

    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'UpdateState',
          id: ioId,
          state: state
        })
      })
    } catch {
      // WebSocket server might not be running
    }

    return res.json({
      success: true,
      ioId,
      state,
      stateString: state ? 'TRUE' : 'FALSE'
    })
  } catch (error) {
    console.error('[IO State] Error:', error)
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read state'
    })
  }
}
