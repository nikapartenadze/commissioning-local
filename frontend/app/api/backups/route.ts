import { Request, Response } from 'express'
import { listBackups, createBackup } from '@/lib/db/backup'

export async function GET(req: Request, res: Response) {
  try {
    const backups = await listBackups()
    return res.json({ success: true, backups })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}

export async function POST(req: Request, res: Response) {
  try {
    const body = req.body || {}
    const reason = body.reason || 'manual'
    const backup = await createBackup(reason)
    return res.json({ success: true, backup })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
