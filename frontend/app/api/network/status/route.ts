import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'
import { hasMcm, readTypedTagsForMcm } from '@/lib/mcm-registry'

let createdTags = new Set<string>()
let failedTags = new Set<string>()
let lastConnectedState = false

// Diagnostic: per-tag last-known value, used to log transitions like
// "X:I.ConnectionFaulted false → true". The IO grid greys out rows whose
// device has ConnectionFaulted=true, but the decision is made client-side
// from this endpoint's response — so the only persistent record of WHY a
// device went grey lives here. Module-level on purpose: resets on service
// restart, which is fine.
const previousTagValues = new Map<string, boolean | null>()

/**
 * GET /api/network/status — live values for network ring/node/port StatusTags.
 *
 * Mode-aware (multi-MCM / central server): each NetworkRing's StatusTags are
 * bucketed by the ring's SubsystemId. Rings whose subsystem is a registry MCM
 * are read through the typed batch ops — in-process when embedded, via the
 * plc-gateway when PLC_MODE=remote. Unregistered subsystems keep the legacy
 * singleton cached-read path (single-MCM field tablets).
 *
 * Previously the whole endpoint gated on `hasPlcClient() && isConnected` and
 * read every StatusTag via the singleton; in PLC_MODE=remote the singleton is
 * never connected, so the entire fleet's topology view rendered all-grey.
 */
export async function GET(req: Request, res: Response) {
  try {
    const subsystemId = parseInt(req.query.subsystemId as string || '')

    const singletonConnected = hasPlcClient() && getPlcClient().isConnected
    if (!singletonConnected) {
      lastConnectedState = false
    } else if (!lastConnectedState) {
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

    // Fallback: a port row may have a DeviceName but NULL StatusTag — this
    // happens when topology was seeded from CSV/older import without the
    // explicit fault-tag column. Default to <DeviceName>:I.ConnectionFaulted,
    // the standard Allen-Bradley EtherNet/IP module fault tag (VSU_SEW,
    // FIOM, POINT_IO, etc. all use this). Mutate the port object so the
    // response in `result` later picks up the resolved tag too.
    for (const ring of rings) {
      for (const node of ring.nodes) {
        for (const port of node.ports) {
          if (!port.StatusTag && port.DeviceName) {
            port.StatusTag = `${port.DeviceName}:I.ConnectionFaulted`
          }
        }
      }
    }

    // Bucket every StatusTag by its owning ring's SubsystemId. Rings whose
    // subsystem is a registry MCM read through the mode-aware typed batch
    // (embedded in-process, or the plc-gateway in PLC_MODE=remote); everything
    // else keeps the legacy singleton cached-read path (field tablets).
    const statusTags = new Set<string>()
    const registryTagsBySid = new Map<string, Set<string>>()
    const legacyTags = new Set<string>()
    const addTag = (ringSubsystemId: unknown, tag: string) => {
      statusTags.add(tag)
      const sid = ringSubsystemId != null ? String(ringSubsystemId) : ''
      if (sid && hasMcm(sid)) {
        const set = registryTagsBySid.get(sid) ?? new Set<string>()
        set.add(tag)
        registryTagsBySid.set(sid, set)
      } else {
        legacyTags.add(tag)
      }
    }
    for (const ring of rings) {
      if (ring.McmTag) addTag(ring.SubsystemId, ring.McmTag)
      for (const node of ring.nodes) {
        if (node.StatusTag) addTag(ring.SubsystemId, node.StatusTag)
        for (const port of node.ports) {
          if (port.StatusTag) addTag(ring.SubsystemId, port.StatusTag)
        }
      }
    }

    if (statusTags.size === 0) {
      return res.json({ success: true, connected: singletonConnected, tags: {} })
    }

    const results: Record<string, boolean | null> = {}
    let anyConnected = false

    // Registry MCM rings: one typed batch per subsystem, mode-aware (works
    // identically embedded and via the gateway in PLC_MODE=remote). StatusTag
    // names are flattened into one response map — they're controller-scoped
    // and unique per device on real sites.
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

    // Legacy singleton rings (single-MCM field tablets / unregistered subsystems).
    if (singletonConnected && legacyTags.size > 0) {
      anyConnected = true
      const client = getPlcClient()
      const tagArray = Array.from(legacyTags)
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

      for (const tagName of tagArray) {
        if (failedTags.has(tagName)) { results[tagName] = null; continue }
        results[tagName] = client.readTagCached(tagName)
      }
    }

    const connected = anyConnected || singletonConnected

    // Log every transition (false↔true↔null). Catches the "device went red
    // right when operator did X" question without spamming logs during steady
    // state. Skips the first observation of a tag so we don't dump every tag
    // on first boot.
    for (const tagName of Array.from(statusTags)) {
      const next = results[tagName] ?? null
      if (!previousTagValues.has(tagName)) {
        previousTagValues.set(tagName, next)
        continue
      }
      const prev = previousTagValues.get(tagName)
      if (prev !== next) {
        previousTagValues.set(tagName, next)
        const prevStr = prev === null ? 'null' : String(prev)
        const nextStr = next === null ? 'null' : String(next)
        console.log(`[NetworkStatus] ${tagName} ${prevStr} → ${nextStr}`)
      }
    }

    return res.json({ success: true, connected, tags: results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
