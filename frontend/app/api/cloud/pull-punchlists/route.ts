import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

/**
 * POST /api/cloud/pull-punchlists  { subsystemId }
 *
 * Standalone PUNCHLIST-only pull for one subsystem, so a user can refresh just
 * punchlists without the destructive full IO pull. Mirrors pull-estop:
 * subsystem-scoped delete+reinsert — never touches another MCM's punchlists,
 * and a failed/empty cloud fetch keeps the existing local rows.
 */
export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    const bodySubsystemId = req.body?.subsystemId
    const rawSubsystemId = bodySubsystemId != null ? bodySubsystemId
      : (typeof config.subsystemId === 'string' ? parseInt(config.subsystemId, 10) : config.subsystemId)
    const subsystemId = typeof rawSubsystemId === 'string' ? parseInt(rawSubsystemId, 10) : rawSubsystemId

    if (!remoteUrl) {
      return res.status(400).json({ success: false, error: 'Cloud URL not configured' })
    }
    if (!subsystemId || !Number.isFinite(subsystemId)) {
      return res.status(400).json({ success: false, error: 'Subsystem ID not configured' })
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiPassword) headers['X-API-Key'] = apiPassword

    const cloudUrl = `${remoteUrl}/api/sync/punchlists?subsystemId=${subsystemId}`
    console.log(`[PullPunchlists] Fetching from ${cloudUrl}`)

    const response = await fetch(cloudUrl, { headers, signal: AbortSignal.timeout(15000) })
    if (!response.ok) {
      if (response.status === 404) {
        return res.json({ success: true, punchlists: 0, message: 'No punchlists on cloud' })
      }
      return res.status(502).json({ success: false, error: `Cloud returned ${response.status}` })
    }

    const data = await response.json() as { punchlists?: Array<{ id: number; name: string; ioIds?: number[] }> }
    if (!data.punchlists || data.punchlists.length === 0) {
      return res.json({ success: true, punchlists: 0, message: 'No punchlists on cloud' })
    }

    db.prepare(`DELETE FROM PunchlistItems WHERE PunchlistId IN (SELECT id FROM Punchlists WHERE SubsystemId = ?)`).run(subsystemId)
    db.prepare('DELETE FROM Punchlists WHERE SubsystemId = ?').run(subsystemId)

    const insertPunchlist = db.prepare('INSERT OR REPLACE INTO Punchlists (id, Name, SubsystemId) VALUES (?, ?, ?)')
    const insertItem = db.prepare('INSERT OR IGNORE INTO PunchlistItems (PunchlistId, IoId) VALUES (?, ?)')

    let count = 0, items = 0
    for (const pl of data.punchlists) {
      insertPunchlist.run(pl.id, pl.name, subsystemId)
      for (const ioId of (pl.ioIds || [])) { insertItem.run(pl.id, ioId); items++ }
      count++
    }

    console.log(`[PullPunchlists] Imported ${count} punchlists, ${items} items`)
    return res.json({ success: true, punchlists: count, items })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PullPunchlists] Error:', message)
    return res.status(500).json({ success: false, error: message })
  }
}
