import { NextResponse } from 'next/server'
import { configService } from '@/lib/config'

export async function GET() {
  try {
    const config = await configService.loadConfig()

    return NextResponse.json({
      subsystemId: config.subsystemId || '',
      ip: config.ip || '',
      path: config.path || '1,0',
      remoteUrl: config.remoteUrl || '',
      orderMode: config.orderMode || '0',
      isConfigured: configService.isConfigured(),
    })
  } catch (error) {
    console.error('Failed to load runtime config:', error)
    return NextResponse.json({
      subsystemId: '',
      ip: '',
      path: '1,0',
      remoteUrl: '',
      orderMode: '0',
      isConfigured: false,
    })
  }
}
