import { Request, Response } from 'express'
import { auditLog } from '@/lib/logging/recovery-log'

/**
 * Client outbox eviction report (F4, FV-HARDENING-PLAN.md).
 *
 * When the browser outbox gives up on an FV edit after repeated replay failures
 * it evicts the edit — the value's last copy lives in browser memory/console,
 * which does not survive a refresh. This endpoint writes each evicted edit into
 * the durable server-side recovery log (l2.outbox.evict) so the value stays
 * recoverable even after the tab is gone.
 */
export async function POST(req: Request, res: Response) {
  const edits = Array.isArray(req.body?.edits) ? req.body.edits : []
  if (edits.length === 0) {
    return res.status(400).json({ error: 'edits array required' })
  }
  for (const e of edits.slice(0, 200)) {
    auditLog({
      type: 'l2.outbox.evict',
      user: typeof e?.updatedBy === 'string' ? e.updatedBy : null,
      reason: `client outbox evicted after ${e?.attempts ?? '?'} failed replays — value never reached the server`,
      detail: {
        deviceId: e?.deviceId ?? null,
        columnId: e?.columnId ?? null,
        value: e?.value ?? null,
        ts: e?.ts ?? null,
      },
    })
  }
  return res.json({ success: true, recorded: Math.min(edits.length, 200) })
}
