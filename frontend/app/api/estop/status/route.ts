export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

// Prepared statements — created once, reused per request
const selectZones = db.prepare('SELECT * FROM EStopZones')
const selectEpcs = db.prepare('SELECT * FROM EStopEpcs WHERE ZoneId = ?')
const selectIoPoints = db.prepare('SELECT * FROM EStopIoPoints WHERE EpcId = ?')
const selectVfds = db.prepare('SELECT * FROM EStopVfds WHERE EpcId = ?')

// Track which tags we've already created handles for — reset on PLC reconnect
let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectedState = false

/**
 * GET /api/estop/status
 * Returns EStop zone/EPC data with live PLC tag values from the 75ms polling cache.
 * On first call (or after PLC reconnect), creates tag handles for estop tags.
 */
export async function GET() {
  try {
    const connected = hasPlcClient() && getPlcClient().isConnected

    // Reset tag tracking on PLC reconnect (old handles are destroyed)
    if (!connected) {
      lastConnectedState = false
    } else if (!lastConnectedState) {
      createdTags = new Set<string>()
      failedTags = new Set<string>()
      lastConnectedState = true
      console.log('[EStopStatus] PLC (re)connected, resetting tag handles')
    }

    // Query all zones with nested data
    let zones: any[]
    try {
      zones = selectZones.all() as any[]
      for (const zone of zones) {
        zone.epcs = selectEpcs.all(zone.id) as any[]
        for (const epc of zone.epcs) {
          epc.ioPoints = selectIoPoints.all(epc.id) as any[]
          epc.vfds = selectVfds.all(epc.id) as any[]
          // Convert MustStop from 0/1 integer to boolean
          for (const vfd of epc.vfds) {
            vfd.mustStop = !!vfd.MustStop
          }
        }
      }
    } catch {
      return NextResponse.json({ success: true, connected, zones: [] })
    }

    if (zones.length === 0) {
      return NextResponse.json({ success: true, connected, zones: [] })
    }

    // Collect all unique PLC tags
    const allTags = new Set<string>()
    for (const zone of zones) {
      for (const epc of zone.epcs) {
        allTags.add(epc.CheckTag)
        for (const io of epc.ioPoints) {
          allTags.add(io.Tag)
        }
        for (const vfd of epc.vfds) {
          allTags.add(vfd.StoTag)
        }
      }
    }

    // Read tag values if PLC is connected
    const tagValues: Record<string, boolean | null> = {}

    if (connected) {
      const client = getPlcClient()

      // Create handles for tags not yet in the reader
      const tagsToCreate: string[] = []
      for (const tagName of Array.from(allTags)) {
        if (!createdTags.has(tagName) && !failedTags.has(tagName) && !client.hasTag(tagName)) {
          tagsToCreate.push(tagName)
        }
      }

      if (tagsToCreate.length > 0) {
        console.log(`[EStopStatus] Creating ${tagsToCreate.length} estop tag handles`)
        const tagReader = (client as any).tagReader
        if (tagReader) {
          const result = await tagReader.createTags(tagsToCreate)
          for (const name of result.successful) createdTags.add(name)
          for (const f of result.failed) failedTags.add(f.name)
          console.log(`[EStopStatus] ${result.successful.length} success, ${result.failed.length} failed`)
        }
      }

      // Read cached values from the 75ms polling loop
      let readCount = 0
      let nullCount = 0
      for (const tagName of Array.from(allTags)) {
        if (failedTags.has(tagName)) {
          tagValues[tagName] = null
          nullCount++
          continue
        }
        const val = client.readTagCached(tagName)
        tagValues[tagName] = val
        if (val !== null) readCount++
        else nullCount++
      }

      // Log first time or when values seem off
      if (readCount > 0 || nullCount > 0) {
        const sample = Array.from(allTags).slice(0, 5).map(t => `${t}=${tagValues[t]}`).join(', ')
        console.log(`[EStopStatus] Read ${readCount} values, ${nullCount} null. Sample: ${sample}`)
      }
    }

    // Build structured response
    const result = zones.map((zone: any) => ({
      id: zone.id,
      name: zone.Name,
      epcs: zone.epcs.map((epc: any) => {
        const mustStopVfds = epc.vfds.filter((v: any) => v.mustStop)
        const keepRunningVfds = epc.vfds.filter((v: any) => !v.mustStop)

        return {
          id: epc.id,
          name: epc.Name,
          checkTag: epc.CheckTag,
          checkTagValue: connected ? (tagValues[epc.CheckTag] ?? null) : null,
          ioPoints: epc.ioPoints.map((io: any) => ({
            id: io.id,
            tag: io.Tag,
            value: connected ? (tagValues[io.Tag] ?? null) : null,
          })),
          mustStopVfds: mustStopVfds.map((vfd: any) => ({
            id: vfd.id,
            tag: vfd.Tag,
            stoTag: vfd.StoTag,
            stoActive: connected ? (tagValues[vfd.StoTag] ?? null) : null,
          })),
          keepRunningVfds: keepRunningVfds.map((vfd: any) => ({
            id: vfd.id,
            tag: vfd.Tag,
            stoTag: vfd.StoTag,
            stoActive: connected ? (tagValues[vfd.StoTag] ?? null) : null,
          })),
        }
      }),
    }))

    return NextResponse.json({ success: true, connected, zones: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
