export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

/**
 * GET /api/network/status?subsystemId=45
 * Read ConnectionFaulted tags for all DPMs and devices in the network topology.
 * Tags are preloaded into PLC client on connect — this just reads their current values.
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

    // Read preloaded tags from PLC client
    const client = getPlcClient()
    const results: Record<string, boolean | null> = {}

    for (const tagName of statusTags) {
      try {
        const value = await client.readTag(tagName)
        // ConnectionFaulted: true = faulted, false = healthy
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
