import { Request, Response } from 'express'
import { reconcileConfiguredSubsystems } from '@/lib/cloud/result-reconciler'

/**
 * POST /api/cloud/reconcile
 *
 * On-demand orphan reconciler: scans local results/comments against the cloud
 * and re-enqueues anything the cloud is missing but that has no queue row (the
 * "0 in queue but pull keeps warning" orphans). The normal push loop then
 * delivers them. Returns the per-subsystem counts.
 *
 * Safe to call any time — best-effort, never destructive, never touches Ios.
 */
export async function POST(_req: Request, res: Response) {
  try {
    const results = await reconcileConfiguredSubsystems()
    const enqueued = results.reduce((n, r) => n + r.enqueued, 0)
    const failed = results.filter((r) => !r.ok)
    res.json({
      success: true,
      enqueued,
      subsystems: results,
      ...(failed.length > 0
        ? { warning: `${failed.length} subsystem(s) could not be reached: ${failed.map((f) => `${f.subsystemId} (${f.error})`).join(', ')}` }
        : {}),
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
  }
}
