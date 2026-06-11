import { Request, Response } from 'express'
import { runProjectOp, resolveProject } from '@/lib/logix-sdk-bridge'

/** POST /api/controller-management/comm-path { acd } - read the comm path stored in an ACD. */
export async function POST(req: Request, res: Response) {
  try {
    const { acd } = req.body as { acd?: string }
    if (!acd) return res.status(400).json({ error: 'acd project path required' })
    const result = await runProjectOp({ op: 'comm_path', acd: resolveProject(acd) }, 120_000)
    if (!result.ok) return res.status(500).json({ error: result.error || 'failed to read comm path' })
    return res.json({ ok: true, commPath: result.comm_path || '' })
  } catch (error) {
    console.error('[ControllerMgmt comm-path] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' })
  }
}
