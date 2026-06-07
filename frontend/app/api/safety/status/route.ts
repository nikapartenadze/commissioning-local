import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'
import { hasMcm, readTypedTagsForMcm } from '@/lib/mcm-registry'

let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectedState = false

/**
 * GET /api/safety/status — live values for safety zone BSS tags, drive
 * STOActive bits and safety output tags.
 *
 * Mode-aware (Phase 1.1): zones/outputs whose SubsystemId is a registry MCM
 * read through the typed batch ops — in-process when embedded, via the
 * plc-gateway when PLC_MODE=remote. Unregistered subsystems keep the legacy
 * singleton cached-read path (field tablets).
 */
export async function GET(req: Request, res: Response) {
  try {
    const singletonConnected = hasPlcClient() && getPlcClient().isConnected
    if (!singletonConnected) {
      lastConnectedState = false
    } else if (!lastConnectedState) {
      createdTags = new Set<string>(); failedTags = new Set<string>(); lastConnectedState = true
    }

    const registryTagsBySid = new Map<string, Set<string>>()
    const legacyTags = new Set<string>()
    const addTag = (subsystemId: unknown, tag: string) => {
      const sid = subsystemId != null ? String(subsystemId) : ''
      if (sid && hasMcm(sid)) {
        const set = registryTagsBySid.get(sid) ?? new Set<string>()
        set.add(tag)
        registryTagsBySid.set(sid, set)
      } else {
        legacyTags.add(tag)
      }
    }

    const zones = db.prepare('SELECT * FROM SafetyZones').all() as any[]
    for (const zone of zones) {
      if (zone.BssTag) addTag(zone.SubsystemId, zone.BssTag)
      const drives = db.prepare('SELECT * FROM SafetyZoneDrives WHERE ZoneId = ?').all(zone.id) as any[]
      for (const drive of drives) addTag(zone.SubsystemId, `${drive.Name}:SI.STOActive`)
    }
    const outputs = db.prepare('SELECT Tag, SubsystemId FROM SafetyOutputs').all() as Array<{ Tag: string; SubsystemId?: number }>
    for (const output of outputs) if (output.Tag) addTag(output.SubsystemId, output.Tag)

    if (registryTagsBySid.size === 0 && legacyTags.size === 0) {
      return res.json({ success: true, connected: singletonConnected, tags: {} })
    }

    const results: Record<string, boolean | null> = {}
    let anyConnected = false

    for (const [sid, tags] of Array.from(registryTagsBySid.entries())) {
      try {
        const batch = await readTypedTagsForMcm(sid, Array.from(tags).map((name) => ({ name, dataType: 'BOOL' as const })))
        if (!batch.connected) continue
        anyConnected = true
        for (const r of batch.results) {
          results[r.name] = r.success ? (r.value === true || r.value === 1) : null
        }
      } catch { /* MCM read failed — its tags read as unknown */ }
    }

    if (singletonConnected && legacyTags.size > 0) {
      anyConnected = true
      const client = getPlcClient()
      const tagsToCreate: string[] = []
      for (const tagName of Array.from(legacyTags)) {
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
      for (const tagName of Array.from(legacyTags)) {
        if (failedTags.has(tagName)) { results[tagName] = null; continue }
        results[tagName] = client.readTagCached(tagName)
      }
    }

    return res.json({ success: true, connected: anyConnected || singletonConnected, tags: results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
