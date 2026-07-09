import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getPlcClient, hasPlcClient } from '@/lib/plc-client-manager'
import { hasMcm } from '@/lib/mcm-registry'
import { readBoolTagsBySubsystem } from '@/lib/plc/read-bool-tags'

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

    // Shared bucketed read (registry typed-batch + legacy singleton) — same
    // helper the estop and network status routes use. This route only needs the
    // value map; the per-tag diagnostics are unused here.
    const { values: results, anyConnected } =
      await readBoolTagsBySubsystem({ registryTagsBySid, legacyTags, singletonConnected })

    return res.json({ success: true, connected: anyConnected || singletonConnected, tags: results })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ success: false, error: message })
  }
}
