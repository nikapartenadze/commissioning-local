import { Request, Response } from 'express'
import { getPlcStatus, getPlcTags } from '@/lib/plc-client-manager'
import { configService } from '@/lib/config'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'

export async function GET(req: Request, res: Response) {
  try {
    const plcStatus = getPlcStatus()
    const config = await configService.getConfig()

    const sseClient = getCloudSseClient()
    const cloudConnected = sseClient ? sseClient.isConnected : !!config.remoteUrl
    const cloudMessage = sseClient?.isConnected
      ? `Connected to ${config.remoteUrl}`
      : config.remoteUrl
        ? (sseClient?.connectionState === 'reconnecting' ? 'Reconnecting...' : 'Configured but not connected')
        : 'Cloud not configured'

    let totalTags = 0, respondingTags = 0, errorCount = 0, moduleMessage = 'PLC not connected'

    if (plcStatus.connected) {
      const { tags } = getPlcTags()
      totalTags = tags.length
      respondingTags = tags.filter(t => t.state !== undefined && t.state !== null).length
      errorCount = tags.filter(t => (t as any).error).length
      moduleMessage = `${respondingTags}/${totalTags} tags responding`
      if (errorCount > 0) moduleMessage += ` (${errorCount} errors)`
    }

    return res.json({
      cloud: { connected: cloudConnected, message: cloudMessage },
      backend: { connected: true, message: 'Node.js backend running' },
      plc: { connected: plcStatus.connected, ip: config.ip || '', path: config.path || '1,0', message: plcStatus.connected ? `PLC connected at ${config.ip}` : 'PLC not connected' },
      module: { name: 'All Modules', connected: plcStatus.connected, totalTags, respondingTags, errorCount, message: moduleMessage },
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
