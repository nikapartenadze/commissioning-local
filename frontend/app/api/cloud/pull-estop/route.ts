import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    // Scope by the REQUESTED subsystem (central multi-MCM), not the singleton
    // config.subsystemId. Falling back to config only preserves single-MCM
    // tablet behavior. Central pages MUST pass subsystemId in the body.
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
    if (apiPassword) { headers['X-API-Key'] = apiPassword }

    const cloudUrl = `${remoteUrl}/api/sync/estop?subsystemId=${subsystemId}`
    console.log(`[PullEStop] Fetching from ${cloudUrl}`)

    const response = await fetch(cloudUrl, { headers, signal: AbortSignal.timeout(15000) })

    if (!response.ok) {
      if (response.status === 404) {
        return res.json({ success: true, zones: 0, message: 'No EStop data on cloud' })
      }
      return res.status(502).json({ success: false, error: `Cloud returned ${response.status}` })
    }

    const data = await response.json()

    if (!data.success || !data.zones || data.zones.length === 0) {
      return res.json({ success: true, zones: 0, message: 'No EStop data on cloud' })
    }

    // SCOPED cascade delete — only this subsystem's e-stop data. A global
    // `DELETE FROM EStopZones` here wiped every OTHER MCM's zones on a central
    // server (data-loss). Delete children first, then zones for this subsystem.
    db.prepare(`DELETE FROM EStopIoPoints WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?))`).run(subsystemId)
    db.prepare(`DELETE FROM EStopVfds WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?))`).run(subsystemId)
    db.prepare(`DELETE FROM EStopRelatedEpcs WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?))`).run(subsystemId)
    db.prepare(`DELETE FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?)`).run(subsystemId)
    db.prepare('DELETE FROM EStopZones WHERE SubsystemId = ?').run(subsystemId)

    const insertZoneStmt = db.prepare('INSERT INTO EStopZones (SubsystemId, Name) VALUES (?, ?)')
    const insertEpcStmt = db.prepare('INSERT INTO EStopEpcs (ZoneId, Name, CheckTag) VALUES (?, ?, ?)')
    const insertIoPointStmt = db.prepare('INSERT INTO EStopIoPoints (EpcId, Tag) VALUES (?, ?)')
    const insertVfdStmt = db.prepare('INSERT INTO EStopVfds (EpcId, Tag, StoTag, MustStop) VALUES (?, ?, ?, ?)')
    const insertRelatedEpcStmt = db.prepare('INSERT INTO EStopRelatedEpcs (EpcId, Tag, MustDrop) VALUES (?, ?, ?)')

    let totalEpcs = 0, totalIoPoints = 0, totalVfds = 0, totalRelatedEpcs = 0

    for (const zone of data.zones) {
      const zoneResult = insertZoneStmt.run(subsystemId, zone.name)
      const zoneId = zoneResult.lastInsertRowid
      for (const epc of (zone.epcs || [])) {
        totalEpcs++
        const epcResult = insertEpcStmt.run(zoneId, epc.name, epc.checkTag)
        const epcId = epcResult.lastInsertRowid
        for (const io of (epc.ioPoints || [])) { totalIoPoints++; insertIoPointStmt.run(epcId, io.tag) }
        for (const vfd of (epc.vfds || [])) { totalVfds++; insertVfdStmt.run(epcId, vfd.tag, vfd.stoTag, vfd.mustStop ? 1 : 0) }
        for (const rel of (epc.relatedEpcs || [])) { totalRelatedEpcs++; insertRelatedEpcStmt.run(epcId, rel.tag, rel.mustDrop ? 1 : 0) }
      }
    }

    console.log(`[PullEStop] Imported ${data.zones.length} zones, ${totalEpcs} EPCs, ${totalIoPoints} IO points, ${totalVfds} VFDs, ${totalRelatedEpcs} related EPCs`)
    return res.json({ success: true, zones: data.zones.length, epcs: totalEpcs, ioPoints: totalIoPoints, vfds: totalVfds, relatedEpcs: totalRelatedEpcs })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PullEStop] Error:', message)
    return res.status(500).json({ success: false, error: message })
  }
}
