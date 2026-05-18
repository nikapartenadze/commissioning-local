import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

const selectZones = db.prepare('SELECT * FROM EStopZones')
const selectEpcs = db.prepare('SELECT * FROM EStopEpcs WHERE ZoneId = ?')
const selectIoPoints = db.prepare('SELECT * FROM EStopIoPoints WHERE EpcId = ?')
const selectVfds = db.prepare('SELECT * FROM EStopVfds WHERE EpcId = ?')
const selectRelatedEpcs = db.prepare('SELECT * FROM EStopRelatedEpcs WHERE EpcId = ?')
const selectEpcChecks = db.prepare(
  'SELECT SubsystemId, ZoneName, CheckTag, Result, Comments, FailureMode, TestedBy, TestedAt FROM EStopEpcChecks WHERE SubsystemId = ?'
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
          // EStopRelatedEpcs may not exist yet on databases created before
          // the 2026 Zone Matrix migration. Treat absence as "no relations"
          // rather than failing the whole status read.
          try {
            epc.relatedEpcs = selectRelatedEpcs.all(epc.id) as any[]
            for (const r of epc.relatedEpcs) r.mustDrop = !!r.MustDrop
          } catch { epc.relatedEpcs = [] }
        }
      }
    } catch { return res.json({ success: true, connected, zones: [] }) }

    if (zones.length === 0) return res.json({ success: true, connected, zones: [] })

    const allTags = new Set<string>()
    for (const zone of zones) {
      // <ZONE_NAME>_Nominal_OK — drives the yellow fault blink on zone cards.
      // Field convention: every zone has a corresponding _Nominal_OK BOOL in
      // the PLC that reads true when the zone is healthy.
      zone.nominalOkTag = `${zone.Name}_Nominal_OK`
      allTags.add(zone.nominalOkTag)
      for (const epc of zone.epcs) {
        allTags.add(epc.CheckTag)
        for (const io of epc.ioPoints) allTags.add(io.Tag)
        for (const vfd of epc.vfds) allTags.add(vfd.StoTag)
        for (const rel of (epc.relatedEpcs || [])) allTags.add(rel.Tag)
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
    const checksLookup = new Map<string, { Result: string | null; Comments: string | null; FailureMode: string | null; TestedBy: string | null; TestedAt: string | null }>()
    try {
      const subsystemIds = new Set<number>()
      for (const zone of zones) {
        if (typeof zone.SubsystemId === 'number') subsystemIds.add(zone.SubsystemId)
      }
      for (const sid of Array.from(subsystemIds)) {
        const rows = selectEpcChecks.all(sid) as Array<{ SubsystemId: number; ZoneName: string; CheckTag: string; Result: string | null; Comments: string | null; FailureMode: string | null; TestedBy: string | null; TestedAt: string | null }>
        for (const row of rows) {
          checksLookup.set(`${row.ZoneName}|${row.CheckTag}`, row)
        }
      }
    } catch { /* table may not be ready on first boot; treat as no results */ }

    const result = zones.map((zone: any) => ({
      id: zone.id, name: zone.Name,
      nominalOkTag: zone.nominalOkTag as string,
      nominalOk: connected ? (tagValues[zone.nominalOkTag] ?? null) : null,
      epcs: zone.epcs.map((epc: any) => {
        const mustStopVfds = epc.vfds.filter((v: any) => v.mustStop)
        const keepRunningVfds = epc.vfds.filter((v: any) => !v.mustStop)
        const related: any[] = epc.relatedEpcs || []
        const mustDropTags = related.filter((r: any) => r.mustDrop)
        const mustStayOkTags = related.filter((r: any) => !r.mustDrop)
        const check = checksLookup.get(`${zone.Name}|${epc.CheckTag}`)
        const checkTagValue = connected ? (tagValues[epc.CheckTag] ?? null) : null

        // Auto verdict — only meaningful once the cord has been pulled
        // (CheckTag reads false). Resting state is "ready".
        let autoVerdict: 'ready' | 'pass' | 'fail' | 'unknown' = 'unknown'
        if (!connected || checkTagValue === null) {
          autoVerdict = 'unknown'
        } else if (checkTagValue === true) {
          autoVerdict = 'ready'
        } else {
          let allPass = true
          let anyUnknown = false
          for (const v of mustStopVfds) {
            const got = tagValues[v.StoTag]
            if (got === null || got === undefined) { anyUnknown = true; break }
            if (got !== true) allPass = false
          }
          if (!anyUnknown) for (const v of keepRunningVfds) {
            const got = tagValues[v.StoTag]
            if (got === null || got === undefined) { anyUnknown = true; break }
            if (got !== false) allPass = false
          }
          if (!anyUnknown) for (const r of mustDropTags) {
            const got = tagValues[r.Tag]
            if (got === null || got === undefined) { anyUnknown = true; break }
            if (got !== false) allPass = false
          }
          if (!anyUnknown) for (const r of mustStayOkTags) {
            const got = tagValues[r.Tag]
            if (got === null || got === undefined) { anyUnknown = true; break }
            if (got !== true) allPass = false
          }
          autoVerdict = anyUnknown ? 'unknown' : (allPass ? 'pass' : 'fail')
        }

        return {
          id: epc.id, name: epc.Name, checkTag: epc.CheckTag,
          checkTagValue,
          ioPoints: epc.ioPoints.map((io: any) => ({ id: io.id, tag: io.Tag, value: connected ? (tagValues[io.Tag] ?? null) : null })),
          mustStopVfds: mustStopVfds.map((vfd: any) => ({ id: vfd.id, tag: vfd.Tag, stoTag: vfd.StoTag, stoActive: connected ? (tagValues[vfd.StoTag] ?? null) : null })),
          keepRunningVfds: keepRunningVfds.map((vfd: any) => ({ id: vfd.id, tag: vfd.Tag, stoTag: vfd.StoTag, stoActive: connected ? (tagValues[vfd.StoTag] ?? null) : null })),
          mustDropTags: mustDropTags.map((r: any) => ({ id: r.id, tag: r.Tag, value: connected ? (tagValues[r.Tag] ?? null) : null })),
          mustStayOkTags: mustStayOkTags.map((r: any) => ({ id: r.id, tag: r.Tag, value: connected ? (tagValues[r.Tag] ?? null) : null })),
          autoVerdict,
          result: check?.Result ?? null,
          comments: check?.Comments ?? null,
          failureMode: check?.FailureMode ?? null,
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
