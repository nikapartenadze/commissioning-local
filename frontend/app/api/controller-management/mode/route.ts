import { Request, Response } from 'express'
import { runProjectOp, resolveProject } from '@/lib/logix-sdk-bridge'

/** POST /api/controller-management/mode { acd, comm?, mode } - change controller mode. */
export async function POST(req: Request, res: Response) {
  try {
    const { acd, comm, mode } = req.body as { acd?: string; comm?: string; mode?: string }
    if (!acd) return res.status(400).json({ error: 'acd project path required' })
    const m = String(mode || '').toUpperCase()
    if (!['PROGRAM', 'RUN', 'TEST'].includes(m)) {
      return res.status(400).json({ error: 'mode must be PROGRAM, RUN or TEST' })
    }
    const result = await runProjectOp({ op: 'mode', acd: resolveProject(acd), comm, mode: m }, 180_000)
    if (!result.ok) return res.status(502).json({ error: result.error || 'failed to change mode' })
    return res.json({ ok: true, mode: result.mode, commPath: result.comm_path })
  } catch (error) {
    console.error('[ControllerMgmt mode] Error:', error)
    return res.status(500).json({ error: error instanceof Error ? error.message : 'failed' })
  }
}
