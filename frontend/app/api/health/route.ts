import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

const SERVER_START_TIME = Date.now()

export async function GET(req: Request, res: Response) {
  const mem = process.memoryUsage()

  try {
    // Check database connectivity
    db.prepare('SELECT 1').get()

    return res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      uptime: Math.floor(process.uptime()),
      serverStartTime: new Date(SERVER_START_TIME).toISOString(),
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        externalMB: Math.round(mem.external / 1024 / 1024),
      },
      pid: process.pid,
      nodeVersion: process.version,
    })
  } catch (error) {
    console.error('Health check failed:', error)
    return res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      uptime: Math.floor(process.uptime()),
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
      error: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}
