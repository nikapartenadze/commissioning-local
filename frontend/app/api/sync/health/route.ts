import { Request, Response } from 'express'

export async function GET(req: Request, res: Response) {
  try {
    return res.json({ status: 'healthy', timestamp: new Date().toISOString(), service: 'commissioning-sync-api' })
  } catch (error) {
    console.error('Health check error:', error)
    return res.status(500).json({ status: 'unhealthy', error: 'Health check failed', timestamp: new Date().toISOString() })
  }
}
