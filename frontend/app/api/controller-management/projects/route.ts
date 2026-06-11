import { Request, Response } from 'express'
import { listProjects, LOGIX_PROJECTS_DIR } from '@/lib/logix-sdk-bridge'

/** GET /api/controller-management/projects - list .ACD projects available to download. */
export async function GET(_req: Request, res: Response) {
  try {
    return res.json({ projectsDir: LOGIX_PROJECTS_DIR, projects: listProjects() })
  } catch (error) {
    console.error('[ControllerMgmt projects] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list projects' })
  }
}
