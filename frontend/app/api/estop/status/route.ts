export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

// Track which tags we've already created handles for
// Reset on PLC reconnect (tracked via connectionId)
let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectionId = ''

/**
 * GET /api/estop/status
 * Returns EStop zone/EPC data with live PLC tag values from the 75ms polling cache.
 * On first call (or after PLC reconnect), creates tag handles for estop tags.
 */
export async function GET() {
  try {
    const connected = hasPlcClient() && getPlcClient().isConnected

    // Reset tag tracking on PLC reconnect (handles are invalidated)
    if (connected) {
      const client = getPlcClient()
      const connId = (client as any).connectionId || (client as any).gateway || 'default'
      if (connId !== lastConnectionId) {
        createdTags = new Set<string>()
        failedTags = new Set<string>()
        lastConnectionId = connId
        console.log('[EStopStatus] PLC connection changed, resetting tag handles')
      }
    }

    // Query all zones with nested data
    let zones: any[]
    try {
      zones = await (prisma as any).eStopZone.findMany({
        include: {
          epcs: {
            include: {
              ioPoints: true,
              vfds: true,
            },
          },
        },
      })
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
        allTags.add(epc.checkTag)
        for (const io of epc.ioPoints) {
          allTags.add(io.tag)
        }
        for (const vfd of epc.vfds) {
          allTags.add(vfd.stoTag)
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
          let successCount = 0
          let failCount = 0
          for (const tagName of tagsToCreate) {
            try {
              const result = await tagReader.createTag(tagName, { elemSize: 1, elemCount: 1, timeout: 5000 })
              if (result.success) {
                createdTags.add(tagName)
                successCount++
              } else {
                console.warn(`[EStopStatus] Tag creation failed: ${tagName} — ${result.error}`)
                failedTags.add(tagName)
                failCount++
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              console.warn(`[EStopStatus] Tag creation error: ${tagName} — ${msg}`)
              failedTags.add(tagName)
              failCount++
            }
          }
          console.log(`[EStopStatus] Tag creation complete: ${successCount} success, ${failCount} failed`)
        } else {
          console.warn('[EStopStatus] No tag reader available on PLC client')
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
        // Sample a few values for debug
        const sample = Array.from(allTags).slice(0, 5).map(t => `${t}=${tagValues[t]}`).join(', ')
        console.log(`[EStopStatus] Read ${readCount} values, ${nullCount} null. Sample: ${sample}`)
      }
    }

    // Build structured response
    const result = zones.map((zone: any) => ({
      id: zone.id,
      name: zone.name,
      epcs: zone.epcs.map((epc: any) => {
        const mustStopVfds = epc.vfds.filter((v: any) => v.mustStop)
        const keepRunningVfds = epc.vfds.filter((v: any) => !v.mustStop)

        return {
          id: epc.id,
          name: epc.name,
          checkTag: epc.checkTag,
          checkTagValue: connected ? (tagValues[epc.checkTag] ?? null) : null,
          ioPoints: epc.ioPoints.map((io: any) => ({
            id: io.id,
            tag: io.tag,
            value: connected ? (tagValues[io.tag] ?? null) : null,
          })),
          mustStopVfds: mustStopVfds.map((vfd: any) => ({
            id: vfd.id,
            tag: vfd.tag,
            stoTag: vfd.stoTag,
            stoActive: connected ? (tagValues[vfd.stoTag] ?? null) : null,
          })),
          keepRunningVfds: keepRunningVfds.map((vfd: any) => ({
            id: vfd.id,
            tag: vfd.tag,
            stoTag: vfd.stoTag,
            stoActive: connected ? (tagValues[vfd.stoTag] ?? null) : null,
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
