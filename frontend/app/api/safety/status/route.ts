import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'

let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectedState = false

export async function GET(req: Request, res: Response) {
  try {
    if (!hasPlcClient() || !getPlcClient().isConnected) {
      lastConnectedState = false
      return res.json({ success: true, connected: false, tags: {} })
    }

    if (!lastConnectedState) {
      createdTags = new Set<string>(); failedTags = new Set<string>(); lastConnectedState = true
    }

    const zones = db.prepare('SELECT * FROM SafetyZones').all() as any[]
    const allTags = new Set<string>()
    for (const zone of zones) {
      if (zone.BssTag) allTags.add(zone.BssTag)
      const drives = db.prepare('SELECT * FROM SafetyZoneDrives WHERE ZoneId = ?').all(zone.id) as any[]
      for (const drive of drives) allTags.add(`${drive.Name}:SI.STOActive`)
    }
    const outputs = db.prepare('SELECT Tag FROM SafetyOutputs').all() as { Tag: string }[]
    for (const output of outputs) if (output.Tag) allTags.add(output.Tag)

    if (allTags.size === 0) return res.json({ success: true, connected: true, tags: {} })

    const client = getPlcClient()
    const tagsToCreate: string[] = []
    for (const tagName of Array.from(allTags)) {
      if (!createdTags.has(tagName) && !failedTags.has(tagName) && !client.hasTag(tagName)) tagsToCreate.push(tagName)
    }
    if (tagsToCreate.length > 0) {
      const tagReader = (client as any).tagReader
      if (tagReader) {
        const result = await tagReader.createTags(tagsToCreate)
        for (const name of result.successful) createdTags.add(name)
        for (const f of result.failed) failedTags.add(f.name)
      }
    }

    const results: Record<string, boolean | null> = {}
    for (const tagName of Array.from(allTags)) {
      if (failedTags.has(tagName)) { results[tagName] = null; continue }
      results[tagName] = client.readTagCached(tagName)
    }

    return res.json({ success: true, connected: true, tags: results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
