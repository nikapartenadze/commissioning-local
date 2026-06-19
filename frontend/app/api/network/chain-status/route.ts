import { Request, Response } from 'express'
import { getPlcStatus, getPlcTags } from '@/lib/plc-client-manager'
import { getMcmStatus, getMcmTags } from '@/lib/mcm-registry'
import { configService } from '@/lib/config'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'

/**
 * GET /api/network/chain-status[?subsystemId=]
 *
 * The Cloud → Backend → PLC → Modules status chain for the top breadcrumb bar.
 *
 * Central server: pass ?subsystemId= so the PLC/module nodes reflect THAT MCM's
 * connection + its OWN tag count. Without it, getPlcStatus()/getPlcTags() return
 * the fleet-wide AGGREGATE (the union of every MCM's tags) — which is identical
 * on every /commissioning/:id page (the "3528 on every page" bug). cloud/backend
 * stay global (they are not per-MCM). No subsystemId → singleton (tablet/legacy).
 */
export async function GET(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const sidRaw = req.query.subsystemId
    const sid =
      sidRaw != null &&
      String(sidRaw).trim() !== '' &&
      String(sidRaw).trim() !== '0' &&
      String(sidRaw).trim() !== '_'
        ? String(sidRaw).trim()
        : null

    const sseClient = getCloudSseClient()
    const cloudConnected = sseClient ? sseClient.isConnected : !!config.remoteUrl
    const cloudMessage = sseClient?.isConnected
      ? `Connected to ${config.remoteUrl}`
      : config.remoteUrl
        ? (sseClient?.connectionState === 'reconnecting' ? 'Reconnecting...' : 'Configured but not connected')
        : 'Cloud not configured'

    let plcConnected = false
    let plcIp = config.ip || ''
    let plcPath = config.path || '1,0'
    let totalTags = 0, respondingTags = 0, errorCount = 0
    let moduleMessage = 'PLC not connected'

    if (sid) {
      // Per-MCM (central server): scope to the route subsystem.
      const mcmStatus = getMcmStatus(sid)
      plcConnected = !!mcmStatus?.connected
      plcIp = mcmStatus?.ip || plcIp
      plcPath = mcmStatus?.path || plcPath
      if (plcConnected) {
        const { tags } = getMcmTags(sid)
        totalTags = tags.length
        respondingTags = tags.filter(t => t.state !== undefined && t.state !== null).length
        errorCount = tags.filter(t => (t as any).error).length
        moduleMessage = `${respondingTags}/${totalTags} tags responding`
        if (errorCount > 0) moduleMessage += ` (${errorCount} errors)`
      }
    } else {
      // Singleton/aggregate (tablet, or central landing with no subsystem).
      const plcStatus = getPlcStatus()
      plcConnected = plcStatus.connected
      if (plcStatus.connected) {
        const { tags } = getPlcTags()
        totalTags = tags.length
        respondingTags = tags.filter(t => t.state !== undefined && t.state !== null).length
        errorCount = tags.filter(t => (t as any).error).length
        moduleMessage = `${respondingTags}/${totalTags} tags responding`
        if (errorCount > 0) moduleMessage += ` (${errorCount} errors)`
      }
    }

    return res.json({
      cloud: { connected: cloudConnected, message: cloudMessage },
      backend: { connected: true, message: 'Node.js backend running' },
      plc: { connected: plcConnected, ip: plcIp, path: plcPath, message: plcConnected ? `PLC connected at ${plcIp}` : 'PLC not connected' },
      module: { name: sid ? `MCM ${sid}` : 'All Modules', connected: plcConnected, totalTags, respondingTags, errorCount, message: moduleMessage },
      ioPoint: { name: '', connected: false, message: 'No IO point selected' },
    })
  } catch (error) {
    console.error('Network chain status error:', error)
    return res.json({
      cloud: { connected: false, message: 'Error' },
      backend: { connected: true, message: 'Node.js backend running' },
      plc: { connected: false, message: 'Error checking PLC status' },
      module: { name: '', connected: false, message: 'Error' },
      ioPoint: { name: '', connected: false, message: 'Error' },
    })
  }
}
