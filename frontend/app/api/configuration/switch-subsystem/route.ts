export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { configService } from '@/lib/config'

// POST — Switch to a different subsystem profile
// This saves the config. The UI then calls pull + connect separately for progress feedback.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { profileName, subsystemId, plcIp, plcPath } = body

    if (!subsystemId || !plcIp) {
      return NextResponse.json({ error: 'subsystemId and plcIp are required' }, { status: 400 })
    }

    // Save the new config
    const config = await configService.getConfig()
    await configService.saveConfig({
      ip: plcIp,
      path: plcPath || '1,0',
      subsystemId: String(subsystemId),
      // Preserve cloud settings (remoteUrl, apiPassword)
      remoteUrl: config.remoteUrl,
      apiPassword: config.apiPassword,
    })

    return NextResponse.json({
      success: true,
      message: `Switched to ${profileName || subsystemId}`,
      config: {
        ip: plcIp,
        path: plcPath || '1,0',
        subsystemId: String(subsystemId),
      }
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
