import { Request, Response } from 'express'
import { listQueue } from '@/lib/sync/queue-inspector'

/**
 * Sync Center — list every outbound queue row (IO results, L2/FV/VFD cells,
 * device blockers) with its exact error and a plain-English reason.
 *
 * GET /api/sync/queue?status=all|pending|parked&subsystemId=<id>  (default: all, all MCMs)
 * subsystemId scopes the list + summary to ONE MCM (per-MCM triage view).
 * Read-only: touches ONLY the three *PendingSyncs queue tables.
 */
export async function GET(req: Request, res: Response) {
  try {
    const raw = String(req.query.status || 'all')
    const status = raw === 'pending' || raw === 'parked' ? raw : 'all'
    const sidRaw = req.query.subsystemId
    const sid = sidRaw != null && String(sidRaw).trim() !== '' ? Number(sidRaw) : undefined
    const subsystemId = sid != null && Number.isFinite(sid) ? sid : undefined
    return res.json(listQueue({ status, subsystemId }))
  } catch (error) {
    console.error('Failed to list sync queue:', error)
    return res.status(500).json({ error: 'Failed to list sync queue' })
  }
}
