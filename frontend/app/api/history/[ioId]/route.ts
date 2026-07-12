import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { mergeHistories, type CloudHistoryInput } from '@/lib/history-merge'

interface HistoryRow { id: number; IoId: number; Result: string | null; TestedBy: string | null; Timestamp: string | null; FailureMode: string | null; State: string | null; Comments: string | null; }

/** How long we're willing to stall the history dialog waiting for the cloud.
 *  Offline boxes fail fast (connection refused); this bounds the slow-WAN case. */
const CLOUD_HISTORY_TIMEOUT_MS = 4_000

/**
 * Cloud history is the authoritative cross-tablet record (every field tool
 * pushes its results there), while local TestHistories only sees THIS
 * machine's actions — the delta-sync pipeline does not carry history rows.
 * Best-effort: any failure (offline, 403 for a different-project IO, timeout)
 * degrades to local-only, which is the pre-merge behavior.
 */
async function fetchCloudHistory(ioId: number): Promise<CloudHistoryInput[] | null> {
  let cfg: Awaited<ReturnType<typeof configService.getConfig>> | null = null
  try { cfg = await configService.getConfig() } catch { return null }
  if (!cfg?.remoteUrl || !cfg.apiPassword) return null

  try {
    const res = await fetch(`${cfg.remoteUrl}/api/sync/history/${ioId}`, {
      headers: { 'X-API-Key': cfg.apiPassword },
      signal: AbortSignal.timeout(CLOUD_HISTORY_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data) ? (data as CloudHistoryInput[]) : null
  } catch {
    return null
  }
}

export async function GET(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.ioId as string)

    if (isNaN(ioId)) {
      return res.status(400).json({ error: 'Invalid IO ID' })
    }

    const rows = db.prepare(
      'SELECT * FROM TestHistories WHERE IoId = ? ORDER BY Timestamp DESC LIMIT 100'
    ).all(ioId) as HistoryRow[]

    const local = rows.map(r => ({
      id: r.id, ioId: r.IoId, result: r.Result, testedBy: r.TestedBy, timestamp: r.Timestamp,
      failureMode: r.FailureMode, state: r.State, comments: r.Comments,
    }))

    const cloud = await fetchCloudHistory(ioId)
    const history = mergeHistories(local, cloud ?? [])

    return res.json(history)
  } catch (error) {
    console.error('Error fetching test history:', error)
    return res.status(500).json({ error: 'Failed to fetch test history' })
  }
}
