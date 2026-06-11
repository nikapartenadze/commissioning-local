import { Request, Response } from 'express'
import { runProjectOp, resolveProject } from '@/lib/logix-sdk-bridge'

/** POST /api/controller-management/status { acd, comm? } - read controller mode (online). */
export async function POST(req: Request, res: Response) {
  try {
    const { acd, comm } = req.body as { acd?: string; comm?: string }
    if (!acd) return res.status(400).json({ error: 'acd project path required' })
    const result = await runProjectOp({ op: 'status', acd: resolveProject(acd), comm }, 180_000)
    if (!result.ok) return res.status(502).json({ error: result.error || 'failed to read controller status' })
    return res.json({ ok: true, mode: result.mode, commPath: result.comm_path })
  } catch (error) {
    console.error('[ControllerMgmt status] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' })
  }
}
