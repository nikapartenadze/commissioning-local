export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { getPlcStatus } from '@/lib/plc-client-manager'
import { configService } from '@/lib/config'

export async function GET() {
  try {
    const plcStatus = getPlcStatus()
    const config = await configService.getConfig()

    // Check cloud connection — simple health check
    let cloudConnected = false
    let cloudMessage = 'Cloud not configured'
    if (config.remoteUrl) {
      try {
        const resp = await fetch(`${config.remoteUrl}/api/sync/health`, {
          headers: { 'X-API-Key': config.apiPassword || '' },
          signal: AbortSignal.timeout(5000),
        })
        cloudConnected = resp.ok
        cloudMessage = cloudConnected ? `Connected to ${config.remoteUrl}` : 'Cloud unreachable'
      } catch {
        cloudMessage = 'Cloud unreachable'
      }
    }

    // Return NetworkChainStatus format expected by component
    return NextResponse.json({
      cloud: {
        connected: cloudConnected,
        message: cloudMessage,
      },
      backend: {
        connected: true, // Node.js backend is always connected (we're responding!)
        message: 'Node.js backend running',
      },
      plc: {
        connected: plcStatus.connected,
        ip: config.ip || '',
        path: config.path || '1,0',
        message: plcStatus.connected ? 'PLC connected' : 'PLC not connected',
      },
      module: {
        name: 'All Modules',
        connected: plcStatus.connected,
        totalTags: 0,
        respondingTags: 0,
        errorCount: 0,
        message: 'No modules loaded',
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
