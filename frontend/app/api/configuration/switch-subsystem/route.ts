import { Request, Response } from 'express'
import { configService } from '@/lib/config'

export async function POST(req: Request, res: Response) {
  try {
    const body = req.body
    const { profileName, subsystemId, plcIp, plcPath } = body

    if (!subsystemId || !plcIp) {
      return res.status(400).json({ error: 'subsystemId and plcIp are required' })
    }

    const config = await configService.getConfig()
    await configService.saveConfig({
      ip: plcIp,
      path: plcPath || '1,0',
      subsystemId: String(subsystemId),
      remoteUrl: config.remoteUrl,
      apiPassword: config.apiPassword,
    })

    return res.json({
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
    return res.status(500).json({ error: msg })
  }
}
