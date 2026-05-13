import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

const selectZones = db.prepare('SELECT * FROM EStopZones')
const selectEpcs = db.prepare('SELECT * FROM EStopEpcs WHERE ZoneId = ?')
const selectIoPoints = db.prepare('SELECT * FROM EStopIoPoints WHERE EpcId = ?')
const selectVfds = db.prepare('SELECT * FROM EStopVfds WHERE EpcId = ?')
const selectEpcChecks = db.prepare(
  'SELECT SubsystemId, ZoneName, CheckTag, Result, Comments, TestedBy, TestedAt FROM EStopEpcChecks WHERE SubsystemId = ?'
)

let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectedState = false

export async function GET(req: Request, res: Response) {
  try {
    const connected = hasPlcClient() && getPlcClient().isConnected

    if (!connected) { lastConnectedState = false }
    else if (!lastConnectedState) {
      createdTags = new Set<string>(); failedTags = new Set<string>(); lastConnectedState = true
      console.log('[EStopStatus] PLC (re)connected, resetting tag handles')
    }

    let zones: any[]
    try {
      zones = selectZones.all() as any[]
      for (const zone of zones) {
        zone.epcs = selectEpcs.all(zone.id) as any[]
        for (const epc of zone.epcs) {
          epc.ioPoints = selectIoPoints.all(epc.id) as any[]
          epc.vfds = selectVfds.all(epc.id) as any[]
          for (const vfd of epc.vfds) vfd.mustStop = !!vfd.MustStop
        }
      }
    } catch { return res.json({ success: true, connected, zones: [] }) }

    if (zones.length === 0) return res.json({ success: true, connected, zones: [] })

    const allTags = new Set<string>()
    for (const zone of zones) {
      for (const epc of zone.epcs) {
        allTags.add(epc.CheckTag)
        for (const io of epc.ioPoints) allTags.add(io.Tag)
        for (const vfd of epc.vfds) allTags.add(vfd.StoTag)
      }
    }

    const tagValues: Record<string, boolean | null> = {}

    if (connected) {
      const client = getPlcClient()
      const tagsToCreate: string[] = []
      for (const tagName of Array.from(allTags)) {
        if (!createdTags.has(tagName) && !failedTags.has(tagName) && !client.hasTag(tagName)) tagsToCreate.push(tagName)
      }
      if (tagsToCreate.length > 0) {
        const tagReader = (client as any).tagReader
        if (tagReader) {
          const result = await tagReader.createTags(tagsToCreate)
          for (const name of result.successful) createdTags.add(name)
          for (const f of result.failed) failedTags.add(f.name)
        }
      }
      for (const tagName of Array.from(allTags)) {
        if (failedTags.has(tagName)) { tagValues[tagName] = null; continue }
        tagValues[tagName] = client.readTagCached(tagName)
      }
    }

    // Build a per-(ZoneName, CheckTag) lookup of recorded check results. We
    // index by zoneName+checkTag (not epc.id) so results survive when the
    // cloud-pull recreates EStopEpcs rows with new IDs.
    const checksLookup = new Map<string, { Result: string | null; Comments: string | null; TestedBy: string | null; TestedAt: string | null }>()
    try {
      const subsystemIds = new Set<number>()
      for (const zone of zones) {
        if (typeof zone.SubsystemId === 'number') subsystemIds.add(zone.SubsystemId)
      }
      for (const sid of Array.from(subsystemIds)) {
        const rows = selectEpcChecks.all(sid) as Array<{ SubsystemId: number; ZoneName: string; CheckTag: string; Result: string | null; Comments: string | null; TestedBy: string | null; TestedAt: string | null }>
        for (const row of rows) {
          checksLookup.set(`${row.ZoneName}|${row.CheckTag}`, row)
        }
      }
    } catch { /* table may not be ready on first boot; treat as no results */ }

    const result = zones.map((zone: any) => ({
      id: zone.id, name: zone.Name,
      epcs: zone.epcs.map((epc: any) => {
        const mustStopVfds = epc.vfds.filter((v: any) => v.mustStop)
        const keepRunningVfds = epc.vfds.filter((v: any) => !v.mustStop)
        const check = checksLookup.get(`${zone.Name}|${epc.CheckTag}`)
        return {
          id: epc.id, name: epc.Name, checkTag: epc.CheckTag,
          checkTagValue: connected ? (tagValues[epc.CheckTag] ?? null) : null,
          ioPoints: epc.ioPoints.map((io: any) => ({ id: io.id, tag: io.Tag, value: connected ? (tagValues[io.Tag] ?? null) : null })),
          mustStopVfds: mustStopVfds.map((vfd: any) => ({ id: vfd.id, tag: vfd.Tag, stoTag: vfd.StoTag, stoActive: connected ? (tagValues[vfd.StoTag] ?? null) : null })),
          keepRunningVfds: keepRunningVfds.map((vfd: any) => ({ id: vfd.id, tag: vfd.Tag, stoTag: vfd.StoTag, stoActive: connected ? (tagValues[vfd.StoTag] ?? null) : null })),
          result: check?.Result ?? null,
          comments: check?.Comments ?? null,
          testedBy: check?.TestedBy ?? null,
          testedAt: check?.TestedAt ?? null,
        }
      }),
    }))

    return res.json({ success: true, connected, zones: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
