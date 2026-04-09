import { Request, Response } from 'express'
import { getPlcClient } from '@/lib/plc-client-manager'

export async function POST(req: Request, res: Response) {
  try {
    const { tag, action } = req.body

    if (!tag || typeof tag !== 'string') return res.status(400).json({ success: false, error: 'tag is required' })
    if (!tag.startsWith('STD_')) return res.status(400).json({ success: false, error: 'Only STD_ intermediary tags can be fired' })

    const client = getPlcClient()
    if (!client.isConnected) return res.status(503).json({ success: false, error: 'PLC not connected' })

    const bitValue: number | 'toggle' = action === 'toggle' ? 'toggle' : (action === 'stop' ? 0 : 1)
    const result = client.writeOutputBit({ id: -1, name: tag }, bitValue)

    if (!result.success) return res.status(500).json({ success: false, error: result.error })

    const newState = action === 'toggle' ? !result.currentState : action !== 'stop'
    return res.json({ success: true, tag, state: newState })
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fire safety output' })
  }
}
