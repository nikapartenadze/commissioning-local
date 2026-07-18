import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

const deleteStmt = db.prepare(`DELETE FROM Roadmaps WHERE Mcm = ?`)
const insertStmt = db.prepare(`
  INSERT INTO Roadmaps (Id, ProjectId, Mcm, Name, Description, StepsJson, PathJson, IsPublished, UpdatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    // Honor an explicit subsystemId from the caller (the manual per-MCM pull's
    // pullExtraSections self-call passes it), falling back to the ambient config
    // subsystem for the legacy client callers that send no body. Without this a
    // central/multi-MCM tool would always pull the config subsystem's roadmap,
    // not the MCM actually being pulled.
    const bodySid = (req.body as { subsystemId?: number | string } | undefined)?.subsystemId
    const subsystemId = typeof bodySid === 'number'
      ? bodySid
      : typeof bodySid === 'string'
        ? parseInt(bodySid, 10)
        : typeof config.subsystemId === 'string'
          ? parseInt(config.subsystemId, 10)
          : config.subsystemId

    if (!remoteUrl) return res.status(400).json({ success: false, error: 'Cloud URL not configured' })
    if (!subsystemId) return res.status(400).json({ success: false, error: 'Subsystem ID not configured' })

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiPassword) headers['X-API-Key'] = apiPassword

    const url = `${remoteUrl}/api/sync/roadmaps?subsystemId=${subsystemId}`
    const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) })
    if (!response.ok) {
      if (response.status === 404) return res.json({ success: true, mcm: null, count: 0, message: 'Subsystem not found on cloud' })
      return res.status(502).json({ success: false, error: `Cloud returned ${response.status}` })
    }

    const data = await response.json() as {
      success?: boolean; mcm?: string | null
      roadmaps?: Array<{ id: number; projectId: number; mcm: string; name: string; description: string | null;
        stepsJson: unknown; pathJson: unknown; isPublished: boolean; updatedAt: string }>
      message?: string
    }
    if (!data.mcm || !Array.isArray(data.roadmaps)) {
      return res.json({ success: true, mcm: data.mcm ?? null, count: 0, message: data.message || 'No roadmaps' })
    }

    const tx = db.transaction(() => {
      deleteStmt.run(data.mcm!)
      for (const r of data.roadmaps!) {
        insertStmt.run(
          r.id, r.projectId, r.mcm, r.name, r.description,
          JSON.stringify(r.stepsJson ?? []),
          r.pathJson ? JSON.stringify(r.pathJson) : null,
          r.isPublished ? 1 : 0, r.updatedAt,
        )
      }
    })
    tx()

    return res.json({ success: true, mcm: data.mcm, count: data.roadmaps.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PullRoadmap] Error:', message)
    return res.status(500).json({ success: false, error: message })
  }
}
