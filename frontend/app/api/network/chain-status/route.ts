export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { getPlcStatus, getPlcTags } from '@/lib/plc-client-manager'
import { configService } from '@/lib/config'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'

export async function GET() {
  try {
    const plcStatus = getPlcStatus()
    const config = await configService.getConfig()

    // Cloud connection — check SSE state first, fallback to config check
    const sseClient = getCloudSseClient()
    const cloudConnected = sseClient ? sseClient.isConnected : !!config.remoteUrl
    const cloudMessage = sseClient?.isConnected
      ? `Connected to ${config.remoteUrl}`
      : config.remoteUrl
        ? (sseClient?.connectionState === 'reconnecting' ? 'Reconnecting...' : 'Configured but not connected')
        : 'Cloud not configured'

    // Get real tag stats when PLC is connected
    let totalTags = 0
    let respondingTags = 0
    let errorCount = 0
    let moduleMessage = 'PLC not connected'

    if (plcStatus.connected) {
      const { tags } = getPlcTags()
      totalTags = tags.length
      respondingTags = tags.filter(t => t.state !== undefined && t.state !== null).length
      errorCount = tags.filter(t => (t as any).error).length
      moduleMessage = `${respondingTags}/${totalTags} tags responding`
      if (errorCount > 0) moduleMessage += ` (${errorCount} errors)`
    }

    return NextResponse.json({
      cloud: {
        connected: cloudConnected,
        message: cloudMessage,
      },
      backend: {
        connected: true,
        message: 'Node.js backend running',
      },
      plc: {
        connected: plcStatus.connected,
        ip: config.ip || '',
        path: config.path || '1,0',
        message: plcStatus.connected ? `PLC connected at ${config.ip}` : 'PLC not connected',
      },
      module: {
        name: 'All Modules',
        connected: plcStatus.connected,
        totalTags,
        respondingTags,
        errorCount,
        message: moduleMessage,
      },
      ioPoint: {
        name: '',
        connected: false,
        message: 'No IO point selected',
      },
    })
  } catch (error) {
    console.error('Network chain status error:', error)
    return NextResponse.json({
      cloud: { connected: false, message: 'Error' },
      backend: { connected: true, message: 'Node.js backend running' },
      plc: { connected: false, message: 'Error checking PLC status' },
      module: { name: '', connected: false, message: 'Error' },
      ioPoint: { name: '', connected: false, message: 'Error' },
    })
  }
}
