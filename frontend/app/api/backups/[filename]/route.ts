import { Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import { getBackupDbPath, deleteBackup } from '@/lib/db/backup'

export async function GET(req: Request, res: Response) {
  try {
    const filename = req.params.filename as string

    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ success: false, error: 'Invalid filename' })
    }

    const backupsDir = getBackupDbPath()
    const filePath = path.join(backupsDir, filename)

    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(path.resolve(backupsDir))) {
      return res.status(400).json({ success: false, error: 'Invalid filename' })
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Backup not found' })
    }

    const stats = fs.statSync(filePath)

    return res
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Disposition', `attachment; filename="${filename}"`)
      .set('Content-Length', stats.size.toString())
      .sendFile(resolved)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}

export async function DELETE(req: Request, res: Response) {
  try {
    const filename = req.params.filename as string
    await deleteBackup(filename)
    return res.json({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message === 'Backup not found' ? 404 : message.includes('Invalid') ? 400 : 500
    return res.status(status).json({ success: false, error: message })
  }
}
