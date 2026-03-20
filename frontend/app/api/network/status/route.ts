export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

// Track which tags we've already tried to create (avoid retrying failed ones every poll)
const createdTags = new Set<string>()
const failedTags = new Set<string>()

/**
 * GET /api/network/status?subsystemId=45
 * Read ConnectionFaulted tags for all DPMs and devices in the network topology.
 * On first call, creates PLC tag handles for any missing network status tags.
 * Subsequent calls just read the cached values from the polling loop.
 */
export async function GET(request: NextRequest) {
  try {
    const subsystemId = parseInt(request.nextUrl.searchParams.get('subsystemId') || '')

    if (!hasPlcClient() || !getPlcClient().isConnected) {
      return NextResponse.json({ success: true, connected: false, tags: {} })
    }

    const where = !isNaN(subsystemId) ? { subsystemId } : {}

    const rings = await prisma.networkRing.findMany({
      where,
      include: {
        nodes: { include: { ports: true } },
      },
    })

    // Collect all unique status tags
    const statusTags = new Set<string>()
    for (const ring of rings) {
      if (ring.mcmTag) statusTags.add(ring.mcmTag)
      for (const node of ring.nodes) {
        if (node.statusTag) statusTags.add(node.statusTag)
        for (const port of node.ports) {
          if (port.statusTag) statusTags.add(port.statusTag)
        }
      }
    }

    if (statusTags.size === 0) {
      return NextResponse.json({ success: true, connected: true, tags: {} })
    }

    const client = getPlcClient()
    const tagReader = (client as any).tagReader

    // Create handles for any tags not yet loaded (on-the-fly, no reconnect needed)
    if (tagReader) {
      const tagsToCreate: string[] = []
      for (const tagName of statusTags) {
        if (!createdTags.has(tagName) && !failedTags.has(tagName)) {
          tagsToCreate.push(tagName)
        }
      }

      if (tagsToCreate.length > 0) {
        console.log(`[NetworkStatus] Creating ${tagsToCreate.length} network tag handles on-the-fly`)
        for (const tagName of tagsToCreate) {
          try {
            const result = await tagReader.createTag(tagName, { elemSize: 1, elemCount: 1, timeout: 3000 })
            if (result.success) {
              createdTags.add(tagName)
            } else {
              failedTags.add(tagName)
              console.log(`[NetworkStatus] Failed to create tag ${tagName}: ${result.error}`)
            }
          } catch {
            failedTags.add(tagName)
          }
        }
        console.log(`[NetworkStatus] Created ${createdTags.size} tags, ${failedTags.size} failed`)
      }
    }

    // Read values
    const results: Record<string, boolean | null> = {}
    for (const tagName of statusTags) {
      try {
        const value = await client.readTag(tagName)
        results[tagName] = value
      } catch {
        results[tagName] = null
      }
    }

    return NextResponse.json({ success: true, connected: true, tags: results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
