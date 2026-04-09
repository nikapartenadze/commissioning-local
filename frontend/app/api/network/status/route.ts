import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectedState = false

export async function GET(req: Request, res: Response) {
  try {
    const subsystemId = parseInt(req.query.subsystemId as string || '')

    if (!hasPlcClient() || !getPlcClient().isConnected) {
      lastConnectedState = false
      return res.json({ success: true, connected: false, tags: {} })
    }

    if (!lastConnectedState) {
      createdTags = new Set<string>()
      failedTags = new Set<string>()
      lastConnectedState = true
      console.log('[NetworkStatus] PLC (re)connected, resetting tag handles')
    }

    const rings = !isNaN(subsystemId)
      ? db.prepare('SELECT * FROM NetworkRings WHERE SubsystemId = ?').all(subsystemId) as any[]
      : db.prepare('SELECT * FROM NetworkRings').all() as any[]

    for (const ring of rings) {
      ring.nodes = db.prepare('SELECT * FROM NetworkNodes WHERE RingId = ?').all(ring.id) as any[]
      for (const node of ring.nodes) {
        node.ports = db.prepare('SELECT * FROM NetworkPorts WHERE NodeId = ?').all(node.id) as any[]
      }
    }

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
      return res.json({ success: true, connected: true, tags: {} })
    }

    const client = getPlcClient()

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

    const results: Record<string, boolean | null> = {}
    for (const tagName of tagArray) {
      if (failedTags.has(tagName)) { results[tagName] = null; continue }
      results[tagName] = client.readTagCached(tagName)
    }

    return res.json({ success: true, connected: true, tags: results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
