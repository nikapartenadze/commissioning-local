import { Request, Response } from 'express'
import { startAutoSync, stopAutoSync, getAutoSyncService } from '@/lib/cloud/auto-sync'
import type { AutoSyncConfig } from '@/lib/cloud/auto-sync'

export async function POST(req: Request, res: Response) {
  try {
    let config: Partial<AutoSyncConfig> = {}

    try {
      if (req.body) {
        if (req.body.pushIntervalMs) config.pushIntervalMs = req.body.pushIntervalMs
        if (req.body.enabled !== undefined) config.enabled = req.body.enabled
        if (req.body.maxRetries) config.maxRetries = req.body.maxRetries
      }
    } catch {
      // No body or invalid JSON — use defaults
    }

    const service = startAutoSync(config)
    const status = await service.getStatus()

    return res.json({ success: true, message: 'Auto-sync started', status })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return res.status(500).json({ success: false, error: msg })
  }
}

export async function DELETE(req: Request, res: Response) {
  try {
    stopAutoSync()
    return res.json({ success: true, message: 'Auto-sync stopped' })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return res.status(500).json({ success: false, error: msg })
  }
}

export async function GET(req: Request, res: Response) {
  try {
    const service = getAutoSyncService()
    if (!service) {
      return res.json({
        running: false,
        config: null,
        lastPushAt: null,
        lastPullAt: null,
        lastPushResult: null,
        lastPullResult: null,
        pendingCount: null,
      })
    }

    const status = await service.getStatus()
    return res.json(status)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return res.status(500).json({ success: false, error: msg })
  }
}
