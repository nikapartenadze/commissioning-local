export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

// Track which tags we've already created handles for — reset on PLC reconnect
let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectedState = false

/**
 * GET /api/network/status?subsystemId=45
 * Returns cached ConnectionFaulted values from the 75ms polling loop.
 * On first call, creates tag handles for any missing network status tags.
 */
export async function GET(request: NextRequest) {
  try {
    const subsystemId = parseInt(request.nextUrl.searchParams.get('subsystemId') || '')

    if (!hasPlcClient() || !getPlcClient().isConnected) {
      lastConnectedState = false
      return NextResponse.json({ success: true, connected: false, tags: {} })
    }

    // Reset tag tracking when PLC reconnects (old handles are destroyed)
    if (!lastConnectedState) {
      createdTags = new Set<string>()
      failedTags = new Set<string>()
      lastConnectedState = true
      console.log('[NetworkStatus] PLC (re)connected, resetting tag handles')
    }

    // Query rings, nodes, ports
    const rings = !isNaN(subsystemId)
      ? db.prepare('SELECT * FROM NetworkRings WHERE SubsystemId = ?').all(subsystemId) as any[]
      : db.prepare('SELECT * FROM NetworkRings').all() as any[]

    for (const ring of rings) {
      ring.nodes = db.prepare('SELECT * FROM NetworkNodes WHERE RingId = ?').all(ring.id) as any[]
      for (const node of ring.nodes) {
        node.ports = db.prepare('SELECT * FROM NetworkPorts WHERE NodeId = ?').all(node.id) as any[]
      }
    }

    // Collect all unique status tags
    const statusTags = new Set<string>()
    for (const ring of rings) {
      if (ring.McmTag) statusTags.add(ring.McmTag)
      for (const node of ring.nodes) {
        if (node.StatusTag) statusTags.add(node.StatusTag)
        for (const port of node.ports) {
          if (port.StatusTag) statusTags.add(port.StatusTag)
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
        const result = await tagReader.createTags(tagsToCreate)
        for (const name of result.successful) createdTags.add(name)
        for (const f of result.failed) failedTags.add(f.name)
        console.log(`[NetworkStatus] ${result.successful.length} success, ${result.failed.length} failed`)
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
