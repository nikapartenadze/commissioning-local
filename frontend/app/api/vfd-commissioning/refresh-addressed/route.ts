import { Request, Response } from 'express'
import { configService } from '@/lib/config'
import { pullVfdAddressed } from '@/lib/cloud/vfd-addressed-pull'

/**
 * POST /api/vfd-commissioning/refresh-addressed
 *
 * Manual cloud→field refresh of the belt-tracking ADDRESSED flag for one
 * subsystem. Called when the VFD Commissioning tab opens so the read-only
 * ADDRESSED badges reflect what a MECHANIC marked on the cloud, without waiting
 * for the next SSE-reconnect catch-up. Field is read-only — marking is cloud
 * only.
 *
 * Body: { subsystemId }. Best-effort: returns { ok: true, written } on success,
 * { ok: true, written: 0 } when offline / unconfigured (never an error so the
 * VFD page stays usable offline).
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = (req.body ?? {}) as { subsystemId?: unknown }
    const subsystemId = Number(body.subsystemId)
    if (!Number.isInteger(subsystemId) || subsystemId <= 0) {
      return res.status(400).json({ error: 'subsystemId (positive integer) required' })
    }

    const cfg = await configService.getConfig()
    const written = await pullVfdAddressed(subsystemId, {
      remoteUrl: cfg.remoteUrl,
      apiPassword: cfg.apiPassword,
    })

    return res.json({ ok: true, written })
  } catch (error) {
    console.error('[VFD RefreshAddressed] Error:', error)
    return res.status(500).json({
      error: `Failed to refresh addressed: ${error instanceof Error ? error.message : error}`,
    })
  }
}
