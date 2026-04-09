import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const subsystemId = req.query.subsystemId as string | undefined

    if (!subsystemId) return res.json([])

    const punchlists = db.prepare('SELECT id, Name FROM Punchlists WHERE SubsystemId = ? ORDER BY Name').all(parseInt(subsystemId, 10)) as Array<{ id: number; Name: string }>

    if (punchlists.length === 0) return res.json([])

    const getItemsStmt = db.prepare('SELECT IoId FROM PunchlistItems WHERE PunchlistId = ?')
    const getIoStatsStmt = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN Result = 'Passed' THEN 1 ELSE 0 END) as passed, SUM(CASE WHEN Result = 'Failed' THEN 1 ELSE 0 END) as failed FROM Ios WHERE id IN (SELECT IoId FROM PunchlistItems WHERE PunchlistId = ?)`)

    const result = punchlists.map(pl => {
      const items = getItemsStmt.all(pl.id) as Array<{ IoId: number }>
      const ioIds = items.map(item => item.IoId)
      const stats = getIoStatsStmt.get(pl.id) as { total: number; passed: number; failed: number } | undefined
      return { id: pl.id, name: pl.Name, ioIds, total: stats?.total ?? 0, passed: stats?.passed ?? 0, failed: stats?.failed ?? 0 }
    })

    return res.json(result)
  } catch (error) {
    console.error('[Punchlists] Error fetching punchlists:', error)
    return res.json([])
  }
}
