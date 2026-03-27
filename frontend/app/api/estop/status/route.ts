export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

// Track which tags we've already created handles for
const createdTags = new Set<string>()
const failedTags = new Set<string>()

/**
 * GET /api/estop/status
 * Returns EStop zone/EPC data with live PLC tag values from the 75ms polling cache.
 * On first call, creates tag handles for any missing estop tags.
 */
export async function GET() {
  try {
    const connected = hasPlcClient() && getPlcClient().isConnected

    // Query all zones with nested data — table may not exist in schema
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
      // EStopZone model not in schema — return empty
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

      // Create handles for tags not yet in the reader (first call only)
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
          for (const tagName of tagsToCreate) {
            try {
              const result = await tagReader.createTag(tagName, { elemSize: 1, elemCount: 1, timeout: 3000 })
              if (result.success) {
                createdTags.add(tagName)
              } else {
                failedTags.add(tagName)
              }
            } catch {
              failedTags.add(tagName)
            }
          }
        }
      }

      // Read cached values from the 75ms polling loop
      for (const tagName of Array.from(allTags)) {
        if (failedTags.has(tagName)) {
          tagValues[tagName] = null
          continue
        }
        tagValues[tagName] = client.readTagCached(tagName)
      }
    }

    // Build structured response
    const result = zones.map(zone => ({
      id: zone.id,
      name: zone.name,
      epcs: zone.epcs.map(epc => {
        const mustStopVfds = epc.vfds.filter(v => v.mustStop)
        const keepRunningVfds = epc.vfds.filter(v => !v.mustStop)

        return {
          id: epc.id,
          name: epc.name,
          checkTag: epc.checkTag,
          checkTagValue: connected ? (tagValues[epc.checkTag] ?? null) : null,
          ioPoints: epc.ioPoints.map(io => ({
            id: io.id,
            tag: io.tag,
            value: connected ? (tagValues[io.tag] ?? null) : null,
          })),
          mustStopVfds: mustStopVfds.map(vfd => ({
            id: vfd.id,
            tag: vfd.tag,
            stoTag: vfd.stoTag,
            stoActive: connected ? (tagValues[vfd.stoTag] ?? null) : null,
          })),
          keepRunningVfds: keepRunningVfds.map(vfd => ({
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
