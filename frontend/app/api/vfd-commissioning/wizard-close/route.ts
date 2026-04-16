import { Request, Response } from 'express'
import { getPlcStatus } from '@/lib/plc-client-manager'
import { closeWizardReader } from '@/lib/vfd-wizard-reader'

/**
 * POST /api/vfd-commissioning/wizard-close
 *
 * Stops the polling reader for a device, destroys handles, frees PLC resources.
 * Optional — readers auto-expire after 2 minutes of no use, but explicit close
 * is best practice.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName } = req.body
    if (!deviceName) return res.status(400).json({ error: 'deviceName required' })

    const { connectionConfig } = getPlcStatus()
    if (connectionConfig) {
      closeWizardReader(deviceName, connectionConfig.ip, connectionConfig.path)
    }

    return res.json({ success: true })
  } catch (error) {
    return res.status(500).json({ error: `Close failed: ${error instanceof Error ? error.message : error}` })
  }
}
