import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { auditLog } from '@/lib/logging/recovery-log'

/**
 * POST /api/cloud/unpark   body: { queue, pendingId } | { queue, subsystemId, all: true }
 *
 * F8 (2026-07-03 sync audit): recovery path for PARKED rows in the non-IO
 * queues (L2 / e-stop / guided / device-blocker), which the stuck list now
 * surfaces. Un-parking clears DeadLettered + RetryCount so the normal push
 * loop retries the row. This is the recovery path that pairs with the IO
 * queue's force-push:
 *   - L2 cells self-heal on re-push now that the cloud gate is monotonic
 *     lte (a parked stale-version cell rebases + wins).
 *   - e-stop / guided / device-blocker re-attempt against the cloud; if the
 *     cloud still rejects, they re-park (never silently dropped).
 *
 * IO rows are intentionally NOT handled here — use /api/cloud/push-force,
 * which force-overwrites past the version gate with a pre-force backup.
 *
 * A deliberate, confirmed operator action; every un-park is journaled.
 */
const QUEUE_TABLES: Record<string, { table: string; subsystemCol: string | null }> = {
  l2: { table: 'L2PendingSyncs', subsystemCol: null }, // no subsystem FK
  estop: { table: 'EStopCheckPendingSyncs', subsystemCol: 'SubsystemId' },
  guided: { table: 'GuidedTaskStatePendingSyncs', subsystemCol: 'SubsystemId' },
  'device-blocker': { table: 'DeviceBlockerPendingSyncs', subsystemCol: 'SubsystemId' },
}

export async function POST(req: Request, res: Response) {
  try {
    const queue = String(req.body?.queue ?? '')
    const spec = QUEUE_TABLES[queue]
    if (!spec) {
      return res.status(400).json({
        success: false,
        error: `Invalid queue "${queue}". Use one of: ${Object.keys(QUEUE_TABLES).join(', ')} (IO rows use /api/cloud/push-force).`,
      })
    }

    const pendingId = req.body?.pendingId != null ? parseInt(String(req.body.pendingId), 10) : null
    const subsystemId = req.body?.subsystemId != null ? parseInt(String(req.body.subsystemId), 10) : null
    const all = req.body?.all === true

    let sql: string
    let args: number[]
    if (pendingId != null && Number.isFinite(pendingId)) {
      sql = `UPDATE ${spec.table} SET DeadLettered = 0, RetryCount = 0 WHERE id = ? AND DeadLettered = 1`
      args = [pendingId]
    } else if (all && subsystemId != null && Number.isFinite(subsystemId) && spec.subsystemCol) {
      sql = `UPDATE ${spec.table} SET DeadLettered = 0, RetryCount = 0 WHERE ${spec.subsystemCol} = ? AND DeadLettered = 1`
      args = [subsystemId]
    } else {
      return res.status(400).json({
        success: false,
        error: spec.subsystemCol
          ? 'Provide { queue, pendingId } or { queue, subsystemId, all: true }'
          : 'Provide { queue, pendingId } (this queue has no subsystem scope for bulk un-park)',
      })
    }

    const result = db.prepare(sql).run(...args)
    auditLog({
      type: 'sync.reconcile.enqueue',
      subsystemId: subsystemId ?? undefined,
      reason: `operator un-parked ${result.changes} ${queue} row(s) for retry`,
      detail: { queue, pendingId, all, unparked: result.changes },
    })

    return res.json({ success: true, queue, unparked: result.changes })
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Un-park failed' })
  }
}
