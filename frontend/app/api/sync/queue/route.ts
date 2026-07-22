import { Request, Response } from 'express'
import { listQueue } from '@/lib/sync/queue-inspector'

/**
 * Sync Center — list every outbound queue row (IO results, L2/FV/VFD cells,
 * device blockers) with its exact error and a plain-English reason.
 *
 * GET /api/sync/queue?status=all|pending|parked|orphaned|resolved&subsystemId=<id>
 *   (default: all, all MCMs)
 * subsystemId scopes the list + summary to ONE MCM (per-MCM triage view).
 * Read-only: touches ONLY the three *PendingSyncs queue tables.
 *
 * `resolved` (cloud target provably removed; the tool cleared it by itself) is
 * reachable ONLY by asking for it by name. listQueue already excludes it from
 * 'all', so widening this clamp cannot leak a resolved row into the default
 * view or into any attention count — it just stops the UI from being unable to
 * show a state the database has. A status the server silently rewrites to
 * something else is worse than a 400: the caller gets the wrong rows and no
 * indication of it.
 */
const ALLOWED_STATUS = new Set(['all', 'pending', 'parked', 'orphaned', 'resolved'])

export async function GET(req: Request, res: Response) {
  try {
    const raw = String(req.query.status || 'all')
    const status = (ALLOWED_STATUS.has(raw) ? raw : 'all') as
      'all' | 'pending' | 'parked' | 'orphaned' | 'resolved'
    const sidRaw = req.query.subsystemId
    const sid = sidRaw != null && String(sidRaw).trim() !== '' ? Number(sidRaw) : undefined
    const subsystemId = sid != null && Number.isFinite(sid) ? sid : undefined
    return res.json(listQueue({ status, subsystemId }))
  } catch (error) {
    console.error('Failed to list sync queue:', error)
    return res.status(500).json({ error: 'Failed to list sync queue' })
  }
}
