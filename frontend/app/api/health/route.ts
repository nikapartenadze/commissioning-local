import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

const SERVER_START_TIME = Date.now().toString()

export async function GET(req: Request, res: Response) {
  try {
    // Check database connectivity
    db.prepare('SELECT 1').get()

    return res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      serverStartTime: SERVER_START_TIME,
    })
  } catch (error) {
    console.error('Health check failed:', error)
    return res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}
