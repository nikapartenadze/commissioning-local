import { Request, Response } from 'express'
import { configService } from '@/lib/config/config-service'

/**
 * GET /api/sharepoint/status
 * Config presence only — NO network call. Drives the "Push to SharePoint"
 * toggle in the batch-upload dialog. Never returns the client secret.
 */
export async function GET(_req: Request, res: Response) {
  await configService.getConfig() // ensure config loaded
  const cfg = configService.getSharePointConfig()
  return res.json({
    configured: configService.isSharePointConfigured(),
    siteUrl: cfg.siteUrl || '',
    folderPath: cfg.folderPath || '',
  })
}
