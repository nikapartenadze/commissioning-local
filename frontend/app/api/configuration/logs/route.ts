import { Request, Response } from 'express'
import { getConfigLogs, clearConfigLogs } from '@/lib/config/config-log'

export async function GET(req: Request, res: Response) {
  const afterId = parseInt(req.query.afterId as string || '0', 10)
  const result = getConfigLogs(afterId)
  return res.json(result)
}

export async function DELETE(req: Request, res: Response) {
  clearConfigLogs()
  return res.json({ success: true })
}
