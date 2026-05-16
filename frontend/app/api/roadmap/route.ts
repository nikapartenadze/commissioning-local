import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

interface SubsystemRow { Name: string | null }
interface RoadmapRow {
  Id: number
  ProjectId: number
  Mcm: string
  Name: string
  Description: string | null
  StepsJson: string
  PathJson: string | null
  IsPublished: number
  UpdatedAt: string | null
}

/**
 * GET /api/roadmap?subsystemId=N
 *
 * Resolves the subsystem's MCM name from the local Subsystems table, then
 * returns all published Roadmap rows for that MCM, ordered newest-first.
 */
export async function GET(req: Request, res: Response) {
  const subsystemIdRaw = req.query.subsystemId
  const subsystemId = typeof subsystemIdRaw === 'string'
    ? parseInt(subsystemIdRaw, 10)
    : NaN
  if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ error: 'Valid subsystemId query param is required' })
  }

  const subsystem = db
    .prepare(`SELECT Name FROM Subsystems WHERE id = ?`)
    .get(subsystemId) as SubsystemRow | undefined

  if (!subsystem?.Name) {
    return res.json({ subsystemId, mcm: null, roadmaps: [] })
  }

  const rows = db.prepare(`
    SELECT Id, ProjectId, Mcm, Name, Description, StepsJson, PathJson, IsPublished, UpdatedAt
      FROM Roadmaps
     WHERE Mcm = ? AND IsPublished = 1
     ORDER BY datetime(UpdatedAt) DESC
  `).all(subsystem.Name) as RoadmapRow[]

  return res.json({
    subsystemId,
    mcm: subsystem.Name,
    roadmaps: rows.map(r => ({
      id: r.Id,
      projectId: r.ProjectId,
      mcm: r.Mcm,
      name: r.Name,
      description: r.Description,
      stepsJson: JSON.parse(r.StepsJson || '[]'),
      pathJson: r.PathJson ? JSON.parse(r.PathJson) : null,
      isPublished: r.IsPublished === 1,
      updatedAt: r.UpdatedAt,
    })),
  })
}
