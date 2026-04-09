import { Request, Response } from 'express'
import { configService } from '@/lib/config'

export async function GET(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()

    return res.json({
      subsystemId: config.subsystemId || '',
      ip: config.ip || '',
      path: config.path || '1,0',
      remoteUrl: config.remoteUrl || '',
      orderMode: config.orderMode || '0',
      isConfigured: configService.isConfigured(),
    })
  } catch (error) {
    console.error('Failed to load runtime config:', error)
    return res.json({
      subsystemId: '',
      ip: '',
      path: '1,0',
      remoteUrl: '',
      orderMode: '0',
      isConfigured: false,
    })
  }
}
