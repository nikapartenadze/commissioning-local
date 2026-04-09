import { Request, Response } from 'express'

export async function GET(req: Request, res: Response) {
  return res.json({ success: true, modules: [], timestamp: new Date().toISOString() })
}
