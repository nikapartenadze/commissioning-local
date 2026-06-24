import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

const selectZones = db.prepare('SELECT * FROM EStopZones')
const selectZonesBySubsystem = db.prepare('SELECT * FROM EStopZones WHERE SubsystemId = ?')
const selectEpcs = db.prepare('SELECT * FROM EStopEpcs WHERE ZoneId = ?')
const selectIoPoints = db.prepare('SELECT * FROM EStopIoPoints WHERE EpcId = ?')
const selectVfds = db.prepare('SELECT * FROM EStopVfds WHERE EpcId = ?')
const selectRelatedEpcs = db.prepare('SELECT * FROM EStopRelatedEpcs WHERE EpcId = ?')
const selectEpcChecks = db.prepare(
  'SELECT SubsystemId, ZoneName, CheckTag, CheckType, Result, Comments, FailureMode, TestedBy, TestedAt FROM EStopEpcChecks WHERE SubsystemId = ?'
)

let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectedState = false

/**
 * Classify a libplctag read/create failure message as "the controller has no
 * such tag" (a NAME MISMATCH — the most common real-world E-Stop problem) vs a
 * generic read error. Used to give the tester an honest reason for a blank
 * value instead of silently collapsing every failure to null.
 */
function isNotFoundError(msg?: string): boolean {
  if (!msg) return false
  return /not.?found|no such|unknown tag|bad.?param|ERR_NOT_FOUND|0x0?4\b|0x0?5\b/i.test(msg)
}

type TagReadStatus = 'ok' | 'not_found' | 'read_error' | 'mcm_disconnected'

export async function GET(req: Request, res: Response) {
  try {
    const singletonConnected = hasPlcClient() && getPlcClient().isConnected

    if (!singletonConnected) { lastConnectedState = false }
    else if (!lastConnectedState) {
      createdTags = new Set<string>(); failedTags = new Set<string>(); lastConnectedState = true
      console.log('[EStopStatus] PLC (re)connected, resetting tag handles')
    }

    // Scope zones to the requested MCM. The central/multi-MCM tool's per-subsystem
    // pull (/api/mcm/[subsystemId]/pull) deletes+inserts zones scoped BY subsystem,
    // so the local DB can legitimately hold several MCMs' zones at once. Without
    // this filter every MCM's E-Stop tab showed every other MCM's zones too.
    // Falls back to all zones when no subsystemId is supplied (legacy single-MCM
    // field tablets that don't pass the query param).
    const sidRaw = req.query.subsystemId
    const sid = sidRaw != null && sidRaw !== '' ? parseInt(String(sidRaw), 10) : null
    const hasSid = sid != null && Number.isFinite(sid)

    let zones: any[]
    try {
      zones = (hasSid ? selectZonesBySubsystem.all(sid) : selectZones.all()) as any[]
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
    } catch { return res.json({ success: true, connected: singletonConnected, zones: [] }) }

    if (zones.length === 0) return res.json({ success: true, connected: singletonConnected, zones: [] })

    const allTags = new Set<string>()
    // Per-zone owning subsystem — zones whose subsystem is a registry MCM
    // read through the mode-aware typed batch (embedded in-process, or the
    // plc-gateway in PLC_MODE=remote); everything else keeps the legacy
    // singleton cached-read path (field tablets).
    const registryTagsBySid = new Map<string, Set<string>>()
    const legacyTags = new Set<string>()
    const { hasMcm, readTypedTagsForMcm } = await import('@/lib/mcm-registry')
    const addZoneTag = (zone: any, tag: string) => {
      allTags.add(tag)
      const sid = zone.SubsystemId != null ? String(zone.SubsystemId) : ''
      if (sid && hasMcm(sid)) {
        const set = registryTagsBySid.get(sid) ?? new Set<string>()
        set.add(tag)
        registryTagsBySid.set(sid, set)
      } else {
        legacyTags.add(tag)
      }
    }
    for (const zone of zones) {
      // <ZONE_NAME>_Nominal_OK — drives the yellow fault blink on zone cards.
      // The DB zone.Name includes the MCM prefix (e.g. MCM02_ZONE_01_01) for
      // dashboard grouping, but the PLC tag lives at controller scope as
      // ZONE_01_01_Nominal_OK (verified by field: tag MCM02_..._Nominal_OK
      // returns "Not found" on the PLC). Strip the leading MCM##_ prefix to
      // match what's actually in the PLC. Same regex the UI uses to derive
      // zoneLabel in estop-check-view.tsx:445.
      const m = /^([A-Z]+\d+)_(.+)$/.exec(zone.Name)
      const zoneLabel = m ? m[2] : zone.Name
      zone.nominalOkTag = `${zoneLabel}_Nominal_OK`
      addZoneTag(zone, zone.nominalOkTag)
      for (const epc of zone.epcs) {
        addZoneTag(zone, epc.CheckTag)
        for (const io of epc.ioPoints) addZoneTag(zone, io.Tag)
        for (const vfd of epc.vfds) addZoneTag(zone, vfd.StoTag)
        for (const rel of (epc.relatedEpcs || [])) addZoneTag(zone, rel.Tag)
      }
    }

    const tagValues: Record<string, boolean | null> = {}
    // Per-tag read diagnostics so a NOT_FOUND / wrong tag name is VISIBLE to the
    // tester instead of silently collapsing to null (which reads as "no data").
    // A null value can mean three very different things — disambiguate them.
    const tagDiag: Record<string, TagReadStatus> = {}
    const tagErrors: Record<string, string> = {}
    const connectedSids = new Set<string>()
    let anyConnected = false

    // Registry MCM zones: one typed batch per subsystem, mode-aware (works
    // identically embedded and via the gateway in PLC_MODE=remote). Tag
    // names are flattened into one map — they're controller-scoped and
    // unique per zone on real sites.
    for (const [sid, tags] of Array.from(registryTagsBySid.entries())) {
      try {
        const batch = await readTypedTagsForMcm(sid, Array.from(tags).map((name) => ({ name, dataType: 'BOOL' as const })))
        if (!batch.connected) {
          for (const name of Array.from(tags)) tagDiag[name] = 'mcm_disconnected'
          continue
        }
        anyConnected = true
        connectedSids.add(sid)
        for (const r of batch.results) {
          if (r.success) {
            tagValues[r.name] = r.value === true || r.value === 1
            tagDiag[r.name] = 'ok'
          } else {
            tagValues[r.name] = null
            tagDiag[r.name] = isNotFoundError(r.error) ? 'not_found' : 'read_error'
            if (r.error) tagErrors[r.name] = r.error
          }
        }
      } catch (err) {
        // Whole-batch failure (e.g. gateway RPC threw) — this MCM's zones are
        // unknown; record WHY rather than leaving them indistinguishable from
        // a clean "no data".
        for (const name of Array.from(tags)) {
          tagDiag[name] = 'read_error'
          tagErrors[name] = err instanceof Error ? err.message : String(err)
        }
      }
    }

    // Legacy singleton zones (field tablets / unregistered subsystems).
    if (singletonConnected && legacyTags.size > 0) {
      anyConnected = true
      const client = getPlcClient()
      const tagsToCreate: string[] = []
      for (const tagName of Array.from(legacyTags)) {
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
      for (const tagName of Array.from(legacyTags)) {
        if (failedTags.has(tagName)) { tagValues[tagName] = null; tagDiag[tagName] = 'not_found'; continue }
        const v = client.readTagCached(tagName)
        tagValues[tagName] = v
        // null here = handle exists but the poll loop hasn't produced a value
        // (transient on first read) or the read is erroring — surface it.
        tagDiag[tagName] = v === null ? 'read_error' : 'ok'
      }
    } else if (legacyTags.size > 0) {
      // Singleton not connected — these zones can't be read at all right now.
      for (const tagName of Array.from(legacyTags)) tagDiag[tagName] = 'mcm_disconnected'
    }

    const connected = anyConnected || singletonConnected

    // Build a per-(ZoneName, CheckTag, CheckType) lookup of recorded check
    // results. We index by zoneName+checkTag (not epc.id) so results survive
    // when the cloud-pull recreates EStopEpcs rows with new IDs; CheckType is in
    // the key so BOTH the Preliminary ("zone stop") and Final ("selectivity")
    // results for the same EPC surface simultaneously instead of colliding.
    type CheckRow = { Result: string | null; Comments: string | null; FailureMode: string | null; TestedBy: string | null; TestedAt: string | null }
    const checksLookup = new Map<string, CheckRow>()
    try {
      const subsystemIds = new Set<number>()
      for (const zone of zones) {
        if (typeof zone.SubsystemId === 'number') subsystemIds.add(zone.SubsystemId)
      }
      for (const sid of Array.from(subsystemIds)) {
        const rows = selectEpcChecks.all(sid) as Array<{ SubsystemId: number; ZoneName: string; CheckTag: string; CheckType: string | null; Result: string | null; Comments: string | null; FailureMode: string | null; TestedBy: string | null; TestedAt: string | null }>
        for (const row of rows) {
          const ct = row.CheckType || 'preliminary'
          checksLookup.set(`${row.ZoneName}|${row.CheckTag}|${ct}`, row)
        }
      }
    } catch { /* table may not be ready on first boot; treat as no results */ }

    const result = zones.map((zone: any) => ({
      id: zone.id, name: zone.Name,
      nominalOkTag: zone.nominalOkTag as string,
      // Whether THIS zone's owning controller is actually connected — distinct
      // from the OR'd top-level `connected`, so a zone whose MCM is offline no
      // longer hides under a green "connected" banner with all-null bits.
      mcmConnected: (() => {
        const zsid = zone.SubsystemId != null ? String(zone.SubsystemId) : ''
        return zsid && hasMcm(zsid) ? connectedSids.has(zsid) : singletonConnected
      })(),
      nominalOk: connected ? (tagValues[zone.nominalOkTag] ?? null) : null,
      epcs: zone.epcs.map((epc: any) => {
        const mustStopVfds = epc.vfds.filter((v: any) => v.mustStop)
        const keepRunningVfds = epc.vfds.filter((v: any) => !v.mustStop)
        const related: any[] = epc.relatedEpcs || []
        const mustDropTags = related.filter((r: any) => r.mustDrop)
        const mustStayOkTags = related.filter((r: any) => !r.mustDrop)
        const preliminaryCheck = checksLookup.get(`${zone.Name}|${epc.CheckTag}|preliminary`)
        const finalCheck = checksLookup.get(`${zone.Name}|${epc.CheckTag}|final`)
        const checkTagValue = connected ? (tagValues[epc.CheckTag] ?? null) : null

        type Verdict = 'ready' | 'pass' | 'fail' | 'unknown'

        // The two live auto-suggested verdicts are evaluated separately so the
        // tester can confirm/commit each independently (team decision (a):
        // auto-suggest + tester-commit). Both are only meaningful once the cord
        // has been pulled (CheckTag reads false). Resting state is "ready".
        //
        //   preliminaryVerdict — the POSITIVE "zone stop" check: this EPC's own
        //     drives (mustStopVfds) MUST be in STO (STOActive == true).
        //   finalVerdict — the NEGATIVE "selectivity" check: other zones' drives
        //     (keepRunningVfds) MUST keep running (STOActive == false), and the
        //     related EPCs must behave (mustDrop → false, mustStayOk → true).
        const evalVerdict = (
          checks: Array<{ got: boolean | null | undefined; expect: boolean }>,
        ): Verdict => {
          if (!connected || checkTagValue === null) return 'unknown'
          if (checkTagValue === true) return 'ready'
          let allPass = true
          for (const { got, expect } of checks) {
            if (got === null || got === undefined) return 'unknown'
            if (got !== expect) allPass = false
          }
          return allPass ? 'pass' : 'fail'
        }

        const preliminaryVerdict = evalVerdict(
          mustStopVfds.map((v: any) => ({ got: tagValues[v.StoTag], expect: true })),
        )
        const finalVerdict = evalVerdict([
          ...keepRunningVfds.map((v: any) => ({ got: tagValues[v.StoTag], expect: false })),
          ...mustDropTags.map((r: any) => ({ got: tagValues[r.Tag], expect: false })),
          ...mustStayOkTags.map((r: any) => ({ got: tagValues[r.Tag], expect: true })),
        ])

        return {
          id: epc.id, name: epc.Name, checkTag: epc.CheckTag,
          checkTagValue,
          ioPoints: epc.ioPoints.map((io: any) => ({ id: io.id, tag: io.Tag, value: connected ? (tagValues[io.Tag] ?? null) : null })),
          mustStopVfds: mustStopVfds.map((vfd: any) => ({ id: vfd.id, tag: vfd.Tag, stoTag: vfd.StoTag, stoActive: connected ? (tagValues[vfd.StoTag] ?? null) : null })),
          keepRunningVfds: keepRunningVfds.map((vfd: any) => ({ id: vfd.id, tag: vfd.Tag, stoTag: vfd.StoTag, stoActive: connected ? (tagValues[vfd.StoTag] ?? null) : null })),
          mustDropTags: mustDropTags.map((r: any) => ({ id: r.id, tag: r.Tag, value: connected ? (tagValues[r.Tag] ?? null) : null })),
          mustStayOkTags: mustStayOkTags.map((r: any) => ({ id: r.id, tag: r.Tag, value: connected ? (tagValues[r.Tag] ?? null) : null })),
          // Split live verdicts (auto-suggested, tester commits each).
          preliminaryVerdict,
          finalVerdict,
          // Recorded results per check type — both visible at once.
          preliminaryResult: preliminaryCheck?.Result ?? null,
          preliminaryComments: preliminaryCheck?.Comments ?? null,
          preliminaryFailureMode: preliminaryCheck?.FailureMode ?? null,
          preliminaryTestedBy: preliminaryCheck?.TestedBy ?? null,
          preliminaryTestedAt: preliminaryCheck?.TestedAt ?? null,
          finalResult: finalCheck?.Result ?? null,
          finalComments: finalCheck?.Comments ?? null,
          finalFailureMode: finalCheck?.FailureMode ?? null,
          finalTestedBy: finalCheck?.TestedBy ?? null,
          finalTestedAt: finalCheck?.TestedAt ?? null,
        }
      }),
    }))

    // Per-tag diagnostics: ship only the problems (ok tags are implied by their
    // values). This is what makes a tag-name mismatch VISIBLE in the UI instead
    // of an invisible blank — the tester sees "ZONE_X_Nominal_OK: not found".
    const tagIssues = Object.entries(tagDiag)
      .filter(([, status]) => status !== 'ok')
      .map(([tag, status]) => ({ tag, status, error: tagErrors[tag] || undefined }))
    const diagValues = Object.values(tagDiag)
    const readSummary = {
      total: diagValues.length,
      ok: diagValues.filter((s) => s === 'ok').length,
      notFound: diagValues.filter((s) => s === 'not_found').length,
      readError: diagValues.filter((s) => s === 'read_error').length,
      disconnected: diagValues.filter((s) => s === 'mcm_disconnected').length,
    }

    return res.json({ success: true, connected, zones: result, tagIssues, readSummary })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
