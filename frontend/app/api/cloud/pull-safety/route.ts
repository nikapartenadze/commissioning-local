import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

/**
 * POST /api/cloud/pull-safety  { subsystemId }
 *
 * Standalone SAFETY-only pull (zones / drives / outputs) for one subsystem, so
 * a user can refresh just safety without the destructive full IO pull. Mirrors
 * pull-estop: subsystem-scoped delete+reinsert — never touches another MCM's
 * safety rows, and a failed/empty cloud fetch keeps the existing local rows.
 */
export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    // Scope by the REQUESTED subsystem (central multi-MCM), not the singleton
    // config.subsystemId. Central pages MUST pass subsystemId; single-MCM
    // tablets fall back to config.
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

    const cloudUrl = `${remoteUrl}/api/sync/safety?subsystemId=${subsystemId}`
    console.log(`[PullSafety] Fetching from ${cloudUrl}`)

    const response = await fetch(cloudUrl, { headers, signal: AbortSignal.timeout(15000) })
    if (!response.ok) {
      if (response.status === 404) {
        return res.json({ success: true, zones: 0, outputs: 0, message: 'No safety data on cloud' })
      }
      return res.status(502).json({ success: false, error: `Cloud returned ${response.status}` })
    }

    const data = await response.json() as {
      success?: boolean
      zones?: Array<{ name: string; stoSignal?: string; bssTag?: string; drives?: Array<{ name: string }> }>
      outputs?: Array<{ tag: string; description?: string; outputType?: string }>
    }
    const hasData = data.success && ((data.zones && data.zones.length > 0) || (data.outputs && data.outputs.length > 0))
    if (!hasData) {
      return res.json({ success: true, zones: 0, outputs: 0, message: 'No safety data on cloud' })
    }

    // Scoped delete (children first) then re-insert — other MCMs untouched.
    db.prepare(`DELETE FROM SafetyZoneDrives WHERE ZoneId IN (SELECT id FROM SafetyZones WHERE SubsystemId = ?)`).run(subsystemId)
    db.prepare('DELETE FROM SafetyZones WHERE SubsystemId = ?').run(subsystemId)
    db.prepare('DELETE FROM SafetyOutputs WHERE SubsystemId = ?').run(subsystemId)

    const insertZone = db.prepare('INSERT INTO SafetyZones (SubsystemId, Name, StoSignal, BssTag) VALUES (?, ?, ?, ?)')
    const insertDrive = db.prepare('INSERT INTO SafetyZoneDrives (ZoneId, Name) VALUES (?, ?)')
    const insertOutput = db.prepare('INSERT INTO SafetyOutputs (SubsystemId, Tag, Description, OutputType) VALUES (?, ?, ?, ?)')

    for (const zone of (data.zones || [])) {
      const zr = insertZone.run(subsystemId, zone.name, zone.stoSignal || null, zone.bssTag || null)
      const zoneId = zr.lastInsertRowid
      for (const d of (zone.drives || [])) insertDrive.run(zoneId, d.name)
    }
    for (const o of (data.outputs || [])) insertOutput.run(subsystemId, o.tag, o.description || null, o.outputType || null)

    const zones = (data.zones || []).length
    const outputs = (data.outputs || []).length
    console.log(`[PullSafety] Imported ${zones} safety zones, ${outputs} outputs`)
    return res.json({ success: true, zones, outputs })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PullSafety] Error:', message)
    return res.status(500).json({ success: false, error: message })
  }
}
