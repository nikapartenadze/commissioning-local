import { Request, Response } from 'express'
import { configService } from '@/lib/config/config-service'
import { testConnection } from '@/lib/sharepoint/graph-upload'

/**
 * POST /api/sharepoint/test
 * Real Graph call: acquire a token + resolve the configured site. Lets the
 * user validate the app registration + permissions once they are granted.
 */
export async function POST(_req: Request, res: Response) {
  await configService.getConfig()
  if (!configService.isSharePointConfigured()) {
    return res.status(400).json({ ok: false, error: 'SharePoint not configured' })
  }
  const result = await testConnection(configService.getSharePointConfig())
  return res.json(result)
}
