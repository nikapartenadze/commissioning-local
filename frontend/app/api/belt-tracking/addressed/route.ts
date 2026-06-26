import { Request, Response } from 'express'
import { setVfdAddressed } from '@/lib/db/repositories/vfd-addressed-sync-repository'
import { triggerVfdAddressedPush } from '@/lib/cloud/cloud-sync-service'

/**
 * POST /api/belt-tracking/addressed
 *
 * Records the belt-tracking ADDRESSED toggle for one blocked belt VFD and
 * enqueues a cloud push. ADDRESSED is a mechanic handoff flag ("physical issue
 * fixed — re-run the VFD wizard"); it never clears the block or enables
 * tracking. Mirrors /api/vfd-commissioning/bump-blocker.
 *
 * Body: { subsystemId, deviceName, addressed: boolean, updatedBy? }
 *
 * Persists LOCALLY first (so it reflects immediately and offline), then fires a
 * debounced instant push. Response: { ok: true }. Enqueue is the success
 * criterion; the cloud push is async/best-effort with background retry — same
 * philosophy as the bump-blocker and IO result syncs.
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = (req.body ?? {}) as {
      subsystemId?: unknown
      deviceName?: unknown
      addressed?: unknown
      updatedBy?: unknown
    }

    const subsystemId = Number(body.subsystemId)
    if (!Number.isInteger(subsystemId) || subsystemId <= 0) {
      return res.status(400).json({ error: 'subsystemId (positive integer) required' })
    }

    const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim() : ''
    if (!deviceName) {
      return res.status(400).json({ error: 'deviceName required' })
    }

    if (typeof body.addressed !== 'boolean') {
      return res.status(400).json({ error: 'addressed (boolean) required' })
    }

    const updatedBy =
      typeof body.updatedBy === 'string' && body.updatedBy.trim() ? body.updatedBy.trim() : undefined

    setVfdAddressed({ subsystemId, deviceName, addressed: body.addressed, updatedBy })

    // Fire an instant (debounced) push; the background loop retries the rest.
    triggerVfdAddressedPush()

    return res.json({ ok: true })
  } catch (error) {
    console.error('[BeltTracking Addressed] Error:', error)
    return res.status(500).json({
      error: `Failed to record addressed: ${error instanceof Error ? error.message : error}`,
    })
  }
}
