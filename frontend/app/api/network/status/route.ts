export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

// Track which tags we've already created handles for
const createdTags = new Set<string>()
const failedTags = new Set<string>()

/**
 * GET /api/network/status?subsystemId=45
 * Returns cached ConnectionFaulted values from the 75ms polling loop.
 * On first call, creates tag handles for any missing network status tags.
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

    // Create handles for tags not yet in the reader (first call only)
    const tagArray = Array.from(statusTags)
    const tagsToCreate: string[] = []
    for (const tagName of tagArray) {
      if (!createdTags.has(tagName) && !failedTags.has(tagName) && !client.hasTag(tagName)) {
        tagsToCreate.push(tagName)
      }
    }

    if (tagsToCreate.length > 0) {
      console.log(`[NetworkStatus] Creating ${tagsToCreate.length} network tag handles`)
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

    // Read cached values from the 75ms polling loop — no fresh PLC reads
    const results: Record<string, boolean | null> = {}
    for (const tagName of tagArray) {
      if (failedTags.has(tagName)) {
        results[tagName] = null
        continue
      }
      results[tagName] = client.readTagCached(tagName)
    }

    return NextResponse.json({ success: true, connected: true, tags: results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
