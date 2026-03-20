export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPlcStatus, hasPlcClient } from '@/lib/plc-client-manager'
import { configService } from '@/lib/config'
import {
  createTag,
  plc_tag_destroy,
  plc_tag_read,
  plc_tag_get_bit,
  isLibraryLoaded,
} from '@/lib/plc/libplctag'
import { PlcTagStatus } from '@/lib/plc/types'

/**
 * GET /api/network/status?subsystemId=45
 * Read ConnectionFaulted tags for all DPMs and devices in the network topology.
 * Creates temporary tag handles, reads the bit, destroys them.
 * Returns a map of tagName → faulted (true = faulted/red, false = healthy/green).
 */
export async function GET(request: NextRequest) {
  try {
    const subsystemId = parseInt(request.nextUrl.searchParams.get('subsystemId') || '')

    const plcStatus = getPlcStatus()
    if (!plcStatus.connected || !isLibraryLoaded()) {
      return NextResponse.json({ success: true, connected: false, tags: {} })
    }

    const config = await configService.getConfig()
    const gateway = config.ip
    const path = config.path || '1,0'

    if (!gateway) {
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

    const results: Record<string, boolean | null> = {}

    // Read each tag by creating a temporary handle
    for (const tagName of statusTags) {
      let handle = -1
      try {
        handle = createTag({
          gateway,
          path,
          name: tagName,
          elemSize: 1,
          elemCount: 1,
          timeout: 2000,
        })

        if (handle < 0) {
          results[tagName] = null
          continue
        }

        const readStatus = plc_tag_read(handle, 2000)
        if (readStatus !== PlcTagStatus.PLCTAG_STATUS_OK) {
          results[tagName] = null
        } else {
          const bit = plc_tag_get_bit(handle, 0)
          results[tagName] = bit === 1 // ConnectionFaulted: 1 = faulted, 0 = healthy
        }
      } catch {
        results[tagName] = null
      } finally {
        if (handle >= 0) {
          try { plc_tag_destroy(handle) } catch { /* ignore */ }
        }
      }
    }

    return NextResponse.json({ success: true, connected: true, tags: results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
