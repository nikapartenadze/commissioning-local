import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function GET(req: Request, res: Response) {
  try {
    const projectId = parseInt(req.params.id as string)

    if (isNaN(projectId)) return res.status(400).json({ error: 'Invalid project ID' })

    const ios = db.prepare(`
      SELECT i.*, s.Name as SubsystemName FROM Ios i JOIN Subsystems s ON i.SubsystemId = s.id
      WHERE s.ProjectId = ? ORDER BY s.Name ASC, i.Name ASC
    `).all(projectId) as any[]

    const transformedIos = ios.map((io: any) => ({
      id: io.id, name: io.Name, description: io.Description, result: io.Result,
      timestamp: io.Timestamp, comments: io.Comments, state: null, subsystemName: io.SubsystemName
    }))

    return res.json(transformedIos)
  } catch (error) {
    console.error('Error fetching project IOs:', error)
    return res.status(500).json({ error: 'Failed to fetch project IOs' })
  }
}
