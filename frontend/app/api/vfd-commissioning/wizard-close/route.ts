import { Request, Response } from 'express'
import { getPlcStatus } from '@/lib/plc-client-manager'
import { hasMcm, getEmbeddedMcmConnection } from '@/lib/mcm-registry'
import { closeWizardReader } from '@/lib/vfd-wizard-reader'

/**
 * POST /api/vfd-commissioning/wizard-close
 *
 * Stops the polling reader for a device, destroys handles, frees PLC resources.
 * Optional — readers auto-expire after 2 minutes of no use, but explicit close
 * is best practice.
 *
 * MCM-aware when subsystemId names a registry MCM (central server); in
 * PLC_MODE=remote the close proxies to the gateway-hosted reader (Phase 1.1).
 */
export async function POST(req: Request, res: Response) {
  try {
    const { deviceName, subsystemId } = req.body
    if (!deviceName) return res.status(400).json({ error: 'deviceName required' })

    if (subsystemId !== undefined && subsystemId !== null && subsystemId !== '' && hasMcm(String(subsystemId))) {
      if (process.env.PLC_MODE === 'remote') {
        const { gatewayClient } = await import('@/lib/plc/gateway-client')
        await gatewayClient.wizardClose(String(subsystemId), deviceName)
        return res.json({ success: true })
      }
      const mcm = getEmbeddedMcmConnection(String(subsystemId))
      if (mcm) closeWizardReader(deviceName, mcm.ip, mcm.path)
      return res.json({ success: true })
    }

    const { connectionConfig } = getPlcStatus()
    if (connectionConfig) {
      closeWizardReader(deviceName, connectionConfig.ip, connectionConfig.path)
    }

    return res.json({ success: true })
  } catch (error) {
    return res.status(500).json({ error: `Close failed: ${error instanceof Error ? error.message : error}` })
  }
}
