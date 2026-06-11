import { Request, Response } from 'express'
import { bridgeInstalled, runBridge, LOGIX_PROJECTS_DIR } from '@/lib/logix-sdk-bridge'

/** GET /api/controller-management/health - is the Logix Designer SDK bridge usable? */
export async function GET(_req: Request, res: Response) {
  const inst = bridgeInstalled()
  if (!inst.ok) {
    return res.json({ ok: false, installed: false, reason: inst.reason, python: inst.python, projectsDir: LOGIX_PROJECTS_DIR })
  }
  try {
    const result = await runBridge({ op: 'health' }, undefined, 60_000)
    return res.json({ ok: !!result.ok, installed: true, sdk: result.sdk, error: result.error, projectsDir: LOGIX_PROJECTS_DIR })
  } catch (error) {
    return res.json({
      ok: false,
      installed: true,
      reason: error instanceof Error ? error.message : 'SDK health check failed',
      projectsDir: LOGIX_PROJECTS_DIR,
    })
  }
}
