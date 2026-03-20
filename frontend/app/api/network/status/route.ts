export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

/**
 * GET /api/network/status?subsystemId=45
 * Read ConnectionFaulted tags for all DPMs and devices in the network topology.
 * Returns a map of tagName → faulted (true = faulted/red, false = healthy/green).
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
        nodes: {
          include: { ports: true },
        },
      },
    })

    // Collect all status tags
    const statusTags: string[] = []
    for (const ring of rings) {
      if (ring.mcmTag) statusTags.push(ring.mcmTag)
      for (const node of ring.nodes) {
        if (node.statusTag) statusTags.push(node.statusTag)
        for (const port of node.ports) {
          if (port.statusTag) statusTags.push(port.statusTag)
        }
      }
    }

    if (statusTags.length === 0) {
      return NextResponse.json({ success: true, connected: true, tags: {} })
    }

    // Read all tags from PLC
    const client = getPlcClient()
    const results: Record<string, boolean | null> = {}

    // Read in parallel batches of 10
    const batchSize = 10
    for (let i = 0; i < statusTags.length; i += batchSize) {
      const batch = statusTags.slice(i, i + batchSize)
      const readings = await Promise.allSettled(
        batch.map(async (tag) => {
          const value = await client.readTag(tag)
          return { tag, value }
        })
      )
      for (const result of readings) {
        if (result.status === 'fulfilled') {
          // ConnectionFaulted: true = faulted, false = healthy
          results[result.value.tag] = result.value.value
        }
      }
    }

    return NextResponse.json({ success: true, connected: true, tags: results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
