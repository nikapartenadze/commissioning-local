import { Request, Response } from 'express'
import { startJob, resolveProject, hasRunningJob } from '@/lib/logix-sdk-bridge'

/**
 * POST /api/controller-management/download { acd, comm? }
 * Starts an async download job (Program -> download -> Run). Returns a jobId;
 * poll /api/controller-management/job?id=<jobId> for progress.
 */
export async function POST(req: Request, res: Response) {
  try {
    const { acd, comm } = req.body as { acd?: string; comm?: string }
    if (!acd) return res.status(400).json({ error: 'acd project path required' })
    if (hasRunningJob()) return res.status(409).json({ error: 'A controller download is already in progress — wait for it to finish.' })
    const job = startJob('download', { acd: resolveProject(acd), comm })
    return res.json({ ok: job.status !== 'error', jobId: job.id, status: job.status, error: job.error })
  } catch (error) {
    console.error('[ControllerMgmt download] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'failed to start download' })
  }
}
