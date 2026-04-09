import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const projectId = parseInt(req.params.id as string)

    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid project ID' })

    const subsystems = db.prepare('SELECT id, Name FROM Subsystems WHERE ProjectId = ?').all(projectId) as { id: number; Name: string }[]
    if (subsystems.length === 0) return res.json([])

    const subsystemIds = subsystems.map(s => s.id)
    const placeholders = subsystemIds.map(() => '?').join(',')

    const history = db.prepare(`
      SELECT th.*, i.Name as IoName, i.Description as IoDescription, i.SubsystemId, s.Name as SubsystemName
      FROM TestHistories th JOIN Ios i ON th.IoId = i.id JOIN Subsystems s ON i.SubsystemId = s.id
      WHERE i.SubsystemId IN (${placeholders}) ORDER BY th.Timestamp DESC LIMIT 1000
    `).all(...subsystemIds) as any[]

    const historyWithInfo = history.map((h: any) => ({
      id: h.id, ioId: h.IoId, result: h.Result, state: h.State, comments: h.Comments,
      testedBy: h.TestedBy, timestamp: h.Timestamp, ioName: h.IoName, ioDescription: h.IoDescription,
      subsystemName: h.SubsystemName || `Subsystem ${h.SubsystemId}`
    }))

    return res.json(historyWithInfo)
  } catch (error) {
    console.error('Error fetching project test history:', error)
    return res.status(500).json({ error: 'Failed to fetch test history' })
  }
}
