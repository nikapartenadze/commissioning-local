import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'
import { mergeHistories, type CloudHistoryInput } from '@/lib/history-merge'

interface HistoryRow { id: number; IoId: number; Result: string | null; TestedBy: string | null; Timestamp: string | null; FailureMode: string | null; State: string | null; Comments: string | null; IoName: string | null; IoDescription: string | null; SubsystemId: number | null; SubsystemName: string | null; }

const CLOUD_HISTORY_TIMEOUT_MS = 6_000
const MAX_ROWS = 1000

/**
 * Subsystem-wide cloud history (testhistories + punchlist transitions with
 * io/subsystem info), fetched per managed subsystem in parallel. Best-effort:
 * offline / 403 / timeout just means that subsystem contributes local rows
 * only — same as before the merge existed.
 */
async function fetchCloudHistories(subsystemIds: number[]): Promise<CloudHistoryInput[]> {
  let cfg: Awaited<ReturnType<typeof configService.getConfig>> | null = null
  try { cfg = await configService.getConfig() } catch { return [] }
  if (!cfg?.remoteUrl || !cfg.apiPassword) return []
  const { remoteUrl, apiPassword } = cfg

  const results = await Promise.all(subsystemIds.map(async (sid) => {
    try {
      const res = await fetch(`${remoteUrl}/api/sync/subsystem/${sid}/history`, {
        headers: { 'X-API-Key': apiPassword },
        signal: AbortSignal.timeout(CLOUD_HISTORY_TIMEOUT_MS),
      })
      if (!res.ok) return []
      const data = await res.json()
      return Array.isArray(data) ? (data as CloudHistoryInput[]) : []
    } catch {
      return []
    }
  }))
  return results.flat()
}

export async function GET(req: Request, res: Response) {
  try {
    // Flat IoName/IoDescription/SubsystemName — the All Test History dialog
    // reads these as flat fields (the old nested `io: {...}` shape left the
    // IO Name / Description / Subsystem columns EMPTY).
    const rows = db.prepare(`
      SELECT th.*, i.Name as IoName, i.Description as IoDescription,
             i.SubsystemId as SubsystemId, s.Name as SubsystemName
      FROM TestHistories th
      LEFT JOIN Ios i ON th.IoId = i.id
      LEFT JOIN Subsystems s ON i.SubsystemId = s.id
      ORDER BY th.Timestamp DESC LIMIT ${MAX_ROWS}
    `).all() as HistoryRow[]

    const local = rows.map(r => ({
      id: r.id, ioId: r.IoId, result: r.Result, testedBy: r.TestedBy, timestamp: r.Timestamp,
      failureMode: r.FailureMode, state: r.State, comments: r.Comments,
      ioName: r.IoName, ioDescription: r.IoDescription,
      subsystemName: r.SubsystemName || (r.SubsystemId != null ? `Subsystem ${r.SubsystemId}` : ''),
    }))

    const sidRows = db.prepare('SELECT DISTINCT SubsystemId AS sid FROM Ios WHERE SubsystemId IS NOT NULL').all() as { sid: number }[]
    const cloud = await fetchCloudHistories(sidRows.map(r => r.sid))

    const history = mergeHistories(local, cloud, MAX_ROWS)

    return res.json(history)
  } catch (error) {
    console.error('Failed to fetch test history:', error)
    return res.status(500).json({ error: 'Failed to fetch test history' })
  }
}
