import { Request, Response } from 'express'
import { configService } from '@/lib/config'
import { pullVfdBlockers } from '@/lib/cloud/vfd-blockers-pull'

/**
 * POST /api/vfd-commissioning/refresh-blockers
 *
 * Manual cloud→field refresh of VFD commissioning BLOCKERS for one subsystem.
 * Called when the VFD Commissioning tab opens so a belt blocked on ANOTHER box
 * shows as blocked here immediately, without waiting for the next SSE-reconnect
 * catch-up. Field is read-only — raising/clearing a blocker still flows through
 * the wizard + the DeviceBlockerPendingSyncs outbox.
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
    const written = await pullVfdBlockers(subsystemId, {
      remoteUrl: cfg.remoteUrl,
      apiPassword: cfg.apiPassword,
    })

    return res.json({ ok: true, written })
  } catch (error) {
    console.error('[VFD RefreshBlockers] Error:', error)
    return res.status(500).json({
      error: `Failed to refresh blockers: ${error instanceof Error ? error.message : error}`,
    })
  }
}
