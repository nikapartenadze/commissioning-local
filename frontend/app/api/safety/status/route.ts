export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

// Track created/failed tags — reset on PLC reconnect
let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectedState = false

export async function GET() {
  try {
    if (!hasPlcClient() || !getPlcClient().isConnected) {
      lastConnectedState = false
      return NextResponse.json({ success: true, connected: false, tags: {} })
    }

    // Reset on PLC reconnect
    if (!lastConnectedState) {
      createdTags = new Set<string>()
      failedTags = new Set<string>()
      lastConnectedState = true
      console.log('[SafetyStatus] PLC (re)connected, resetting tag handles')
    }

    // Collect all BSS tags + drive STO tags from safety zones
    const zones = await prisma.safetyZone.findMany({ include: { drives: true } })
    const allTags = new Set<string>()
    for (const zone of zones) {
      if (zone.bssTag) allTags.add(zone.bssTag)
      // Add STO tag for each drive (convention: {driveName}:SI.STOActive)
      for (const drive of zone.drives) {
        allTags.add(`${drive.name}:SI.STOActive`)
      }
    }

    // Also collect STD output tags
    const outputs = await prisma.safetyOutput.findMany({ select: { tag: true } })
    for (const output of outputs) {
      if (output.tag) allTags.add(output.tag)
    }

    if (allTags.size === 0) {
      return NextResponse.json({ success: true, connected: true, tags: {} })
    }

    const client = getPlcClient()

    // Lazily create tag handles
    const tagsToCreate: string[] = []
    for (const tagName of Array.from(allTags)) {
      if (!createdTags.has(tagName) && !failedTags.has(tagName) && !client.hasTag(tagName)) {
        tagsToCreate.push(tagName)
      }
    }

    if (tagsToCreate.length > 0) {
      console.log(`[SafetyStatus] Creating ${tagsToCreate.length} safety tag handles`)
      const tagReader = (client as any).tagReader
      if (tagReader) {
        const result = await tagReader.createTags(tagsToCreate)
        for (const name of result.successful) createdTags.add(name)
        for (const f of result.failed) failedTags.add(f.name)
        console.log(`[SafetyStatus] ${result.successful.length} success, ${result.failed.length} failed`)
      }
    }

    // Read cached values
    const results: Record<string, boolean | null> = {}
    for (const tagName of Array.from(allTags)) {
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
