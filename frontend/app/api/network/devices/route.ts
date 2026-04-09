import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const devices = db.prepare('SELECT DISTINCT NetworkDeviceName FROM Ios WHERE NetworkDeviceName IS NOT NULL ORDER BY NetworkDeviceName ASC').all() as { NetworkDeviceName: string }[]
    const countStmt = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN Result = ? THEN 1 ELSE 0 END) as passed, SUM(CASE WHEN Result = ? THEN 1 ELSE 0 END) as failed FROM Ios WHERE NetworkDeviceName = ?')

    const enriched = devices.map(device => {
      const counts = countStmt.get('Passed', 'Failed', device.NetworkDeviceName) as { total: number; passed: number; failed: number }
      return { name: device.NetworkDeviceName, totalTags: counts.total, passedTags: counts.passed, failedTags: counts.failed, untestedTags: counts.total - counts.passed - counts.failed }
    })

    return res.json(enriched)
  } catch (error) {
    console.error('Failed to fetch network devices:', error)
    return res.status(500).json({ error: 'Failed to fetch network devices' })
  }
}
