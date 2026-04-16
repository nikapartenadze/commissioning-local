import { Request, Response } from 'express'
import { getPlcClient, getPlcStatus } from '@/lib/plc-client-manager'
import { openWizardReader } from '@/lib/vfd-wizard-reader'

/**
 * POST /api/vfd-commissioning/wizard-open
 *
 * Opens a server-side polling reader for one VFD's 8 STS+keypad tags.
 * Reader runs at ~100ms cycles with persistent handles and broadcasts value
 * changes via WebSocket as { type: 'VfdTagUpdate', deviceName, sts }.
 *
 * The wizard subscribes to VfdTagUpdate messages on its WebSocket — no HTTP polling.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName } = req.body
    if (!deviceName) return res.status(400).json({ error: 'deviceName required' })

    const client = getPlcClient()
    if (!client.isConnected) {
      return res.status(503).json({ error: 'PLC not connected' })
    }

    const { connectionConfig } = getPlcStatus()
    if (!connectionConfig) {
      return res.status(503).json({ error: 'No PLC connection config available' })
    }

    const result = await openWizardReader(
      deviceName,
      connectionConfig.ip,
      connectionConfig.path,
    )

    if (!result.ok) {
      return res.status(500).json({ error: result.error || 'Failed to open reader' })
    }

    return res.json({ success: true, tagCount: result.tagCount })
  } catch (error) {
    console.error('[VfdWizardOpen] Error:', error)
    return res.status(500).json({ error: `Open failed: ${error instanceof Error ? error.message : error}` })
  }
}
