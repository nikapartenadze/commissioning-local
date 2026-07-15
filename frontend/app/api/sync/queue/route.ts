import { Request, Response } from 'express'
import { listQueue } from '@/lib/sync/queue-inspector'

/**
 * Sync Center — list every outbound queue row (IO results, L2/FV/VFD cells,
 * device blockers) with its exact error and a plain-English reason.
 *
 * GET /api/sync/queue?status=all|pending|parked  (default: all)
 * Read-only: touches ONLY the three *PendingSyncs queue tables.
 */
export async function GET(req: Request, res: Response) {
  try {
    const raw = String(req.query.status || 'all')
    const status = raw === 'pending' || raw === 'parked' ? raw : 'all'
    return res.json(listQueue({ status }))
  } catch (error) {
    console.error('Failed to list sync queue:', error)
    return res.status(500).json({ error: 'Failed to list sync queue' })
  }
}
