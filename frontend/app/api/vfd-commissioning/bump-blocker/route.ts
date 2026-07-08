import { Request, Response } from 'express'
import {
  enqueueDeviceBlockerSet,
  enqueueDeviceBlockerClear,
} from '@/lib/db/repositories/device-blocker-sync-repository'
import { triggerDeviceBlockerPush } from '@/lib/cloud/cloud-sync-service'
import { auditLog } from '@/lib/logging/recovery-log'

/**
 * POST /api/vfd-commissioning/bump-blocker
 *
 * Records a VFD bump-test blocker (or clears one) as a device-level sync op,
 * enqueued for propagation to the shared Devices.Blocker* columns on cloud.
 * See frontend/specs/2026-06-04-vfd-bump-blocker-design.md.
 *
 * Body (set):
 *   { subsystemId, deviceName, op: 'set',
 *     blockerResponsibleParty, blockerDescription, updatedBy? }
 * Body (clear — conditional on the cloud side):
 *   { subsystemId, deviceName, op: 'clear',
 *     expectedParty, expectedDescription, updatedBy? }
 *
 * Response: { ok: true }. Enqueue is the success criterion; the cloud push is
 * async/best-effort with background retry — same philosophy as IO result sync.
 */

// VFD blocker parties. Kept as a LOCAL const to avoid a parallel-work race with
// the agent adding VFD_BLOCKER_PARTIES to lib/blockers.ts; once that lands this
// can be replaced with `import { VFD_BLOCKER_PARTIES } from '@/lib/blockers'`.
// MUST stay in sync with lib/blockers.ts (VFD_BLOCKER_PARTIES).
const VFD_BLOCKER_PARTIES = ['Controls', 'Electrical', 'Mechanical'] as const

export async function POST(req: Request, res: Response) {
  try {
    const body = (req.body ?? {}) as {
      subsystemId?: unknown
      deviceName?: unknown
      op?: unknown
      blockerResponsibleParty?: unknown
      blockerDescription?: unknown
      expectedParty?: unknown
      expectedDescription?: unknown
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

    const op = body.op
    if (op !== 'set' && op !== 'clear') {
      return res.status(400).json({ error: "op must be 'set' or 'clear'" })
    }

    const updatedBy = typeof body.updatedBy === 'string' && body.updatedBy.trim() ? body.updatedBy.trim() : undefined

    if (op === 'set') {
      const party = typeof body.blockerResponsibleParty === 'string' ? body.blockerResponsibleParty.trim() : ''
      const description = typeof body.blockerDescription === 'string' ? body.blockerDescription.trim() : ''

      if (!(VFD_BLOCKER_PARTIES as readonly string[]).includes(party)) {
        return res
          .status(400)
          .json({ error: `blockerResponsibleParty must be one of ${VFD_BLOCKER_PARTIES.join(' | ')}` })
      }
      if (!description) {
        return res.status(400).json({ error: 'blockerDescription required for op=set' })
      }

      enqueueDeviceBlockerSet({ subsystemId, deviceName, party, description, updatedBy })

      // Durable recovery trail — the queue row is DELETED after a successful
      // cloud push, so without this the set op's existence vanishes.
      auditLog({
        type: 'vfd.blocker',
        subsystemId,
        user: updatedBy ?? null,
        detail: { op: 'set', deviceName, party, description },
      })
    } else {
      const expectedParty = typeof body.expectedParty === 'string' ? body.expectedParty.trim() : ''
      const expectedDescription = typeof body.expectedDescription === 'string' ? body.expectedDescription.trim() : ''

      if (!(VFD_BLOCKER_PARTIES as readonly string[]).includes(expectedParty)) {
        return res
          .status(400)
          .json({ error: `expectedParty must be one of ${VFD_BLOCKER_PARTIES.join(' | ')}` })
      }
      if (!expectedDescription) {
        return res.status(400).json({ error: 'expectedDescription required for op=clear' })
      }

      enqueueDeviceBlockerClear({ subsystemId, deviceName, expectedParty, expectedDescription, updatedBy })

      // Journal the FULL expected pair being cleared — after the conditional
      // clear lands on cloud there is otherwise no record the blocker existed.
      auditLog({
        type: 'vfd.blocker',
        subsystemId,
        user: updatedBy ?? null,
        detail: { op: 'clear', deviceName, expectedParty, expectedDescription },
      })
    }

    // Fire an instant (debounced) push; the background loop retries the rest.
    triggerDeviceBlockerPush()

    return res.json({ ok: true })
  } catch (error) {
    console.error('[VFD BumpBlocker] Error:', error)
    return res.status(500).json({ error: `Failed to record bump blocker: ${error instanceof Error ? error.message : error}` })
  }
}
