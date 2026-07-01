/**
 * Config side-pulls: network / e-stop / safety / punchlist for one subsystem.
 *
 * Extracted from the per-MCM pull route (app/api/mcm/[subsystemId]/pull) so the
 * SAME idempotent logic can run in BOTH the full-pull path and the no-op
 * short-circuit path. Before this, the no-op short-circuit (IO hash unchanged)
 * returned early and skipped all of these, so cloud-side FV/config changes only
 * reached the field after a service restart cleared the in-memory hash. Safety
 * was also DELETEd by the pull transaction but never re-inserted (data loss) —
 * it is now a first-class section here.
 *
 * Each section is a self-contained, subsystem-scoped delete-then-insert unit:
 *  - It only rewrites the given subsystem's rows (other MCMs are never touched).
 *  - Running it twice yields the same rows (idempotent — no duplication).
 *  - A transient cloud failure SKIPS that section (keeps existing local rows);
 *    it never wipes on a failed/empty fetch. Sections are independent — one
 *    failing does not abort the others.
 *
 * The L2/FV pull is intentionally NOT here: it is a self-call to
 * /api/cloud/pull-l2 (which does its own scoped delete+insert) and stays in the
 * route so this module has no HTTP-server dependency and is unit-testable.
 */

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

interface Stmt {
  run: (...args: unknown[]) => { lastInsertRowid: number | bigint; changes: number }
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
}
interface Db {
  prepare: (sql: string) => Stmt
}

export interface SidePullDeps {
  db: Db
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike
}

export interface SidePullResult {
  networkPulled: number
  estopPulled: number
  safetyPulled: number
  punchlistsPulled: number
}

const TIMEOUT_MS = 15_000

export async function runConfigSidePulls(
  subsystemId: number,
  remoteUrl: string,
  apiPassword: string,
  deps: SidePullDeps,
): Promise<SidePullResult> {
  const db = deps.db
  const doFetch: FetchLike = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const base = remoteUrl.replace(/\/$/, '')
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' }
  const result: SidePullResult = { networkPulled: 0, estopPulled: 0, safetyPulled: 0, punchlistsPulled: 0 }

  // ── Network topology ────────────────────────────────────────────────────
  try {
    const res = await doFetch(`${base}/api/network?subsystemId=${subsystemId}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        success?: boolean
        rings?: Array<{
          name: string; mcmName: string; mcmIp?: string; mcmTag?: string
          nodes?: Array<{
            name: string; position: number; ipAddress?: string; cableIn?: string; cableOut?: string
            statusTag?: string; totalPorts?: number
            ports?: Array<{ portNumber: number; cableLabel?: string; deviceName?: string; deviceType?: string; deviceIp?: string; statusTag?: string }>
          }>
        }>
      }
      if (data.success && data.rings && data.rings.length > 0) {
        // Scoped delete (children first) then re-insert.
        db.prepare(`DELETE FROM NetworkPorts WHERE NodeId IN (SELECT id FROM NetworkNodes WHERE RingId IN (SELECT id FROM NetworkRings WHERE SubsystemId = ?))`).run(subsystemId)
        db.prepare(`DELETE FROM NetworkNodes WHERE RingId IN (SELECT id FROM NetworkRings WHERE SubsystemId = ?)`).run(subsystemId)
        db.prepare('DELETE FROM NetworkRings WHERE SubsystemId = ?').run(subsystemId)
        const insertRing = db.prepare('INSERT INTO NetworkRings (SubsystemId, Name, McmName, McmIp, McmTag) VALUES (?, ?, ?, ?, ?)')
        const insertNode = db.prepare('INSERT INTO NetworkNodes (RingId, Name, Position, IpAddress, CableIn, CableOut, StatusTag, TotalPorts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        const insertPort = db.prepare('INSERT INTO NetworkPorts (NodeId, PortNumber, CableLabel, DeviceName, DeviceType, DeviceIp, StatusTag, ParentPortId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        for (const ring of data.rings) {
          const rr = insertRing.run(subsystemId, ring.name, ring.mcmName, ring.mcmIp || null, ring.mcmTag || null)
          const ringId = rr.lastInsertRowid
          for (const node of ring.nodes || []) {
            const nr = insertNode.run(ringId, node.name, node.position, node.ipAddress || null, node.cableIn || null, node.cableOut || null, node.statusTag || null, node.totalPorts || 28)
            const nodeId = nr.lastInsertRowid
            for (const port of node.ports || []) {
              insertPort.run(nodeId, port.portNumber, port.cableLabel || null, port.deviceName || null, port.deviceType || null, port.deviceIp || null, port.statusTag || null, null)
            }
          }
        }
        result.networkPulled = data.rings.length
      }
    }
  } catch (e) {
    console.warn(`[SidePull ${subsystemId}] network failed:`, e instanceof Error ? e.message : e)
  }

  // ── E-Stop zones / EPCs / IO points / VFDs ────────────────────────────────
  try {
    const res = await doFetch(`${base}/api/sync/estop?subsystemId=${subsystemId}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        success?: boolean
        zones?: Array<{ name: string; epcs?: Array<{ name: string; checkTag: string; ioPoints?: Array<{ tag: string }>; vfds?: Array<{ tag: string; stoTag: string; mustStop?: boolean }> }> }>
      }
      if (data.success && data.zones && data.zones.length > 0) {
        db.prepare(`DELETE FROM EStopIoPoints WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?))`).run(subsystemId)
        db.prepare(`DELETE FROM EStopVfds WHERE EpcId IN (SELECT id FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?))`).run(subsystemId)
        db.prepare(`DELETE FROM EStopEpcs WHERE ZoneId IN (SELECT id FROM EStopZones WHERE SubsystemId = ?)`).run(subsystemId)
        db.prepare('DELETE FROM EStopZones WHERE SubsystemId = ?').run(subsystemId)
        const insertZone = db.prepare('INSERT INTO EStopZones (SubsystemId, Name) VALUES (?, ?)')
        const insertEpc = db.prepare('INSERT INTO EStopEpcs (ZoneId, Name, CheckTag) VALUES (?, ?, ?)')
        const insertIoPoint = db.prepare('INSERT INTO EStopIoPoints (EpcId, Tag) VALUES (?, ?)')
        const insertVfd = db.prepare('INSERT INTO EStopVfds (EpcId, Tag, StoTag, MustStop) VALUES (?, ?, ?, ?)')
        for (const zone of data.zones) {
          const zr = insertZone.run(subsystemId, zone.name)
          const zoneId = zr.lastInsertRowid
          for (const epc of zone.epcs || []) {
            const er = insertEpc.run(zoneId, epc.name, epc.checkTag)
            const epcId = er.lastInsertRowid
            for (const io of epc.ioPoints || []) insertIoPoint.run(epcId, io.tag)
            for (const vfd of epc.vfds || []) insertVfd.run(epcId, vfd.tag, vfd.stoTag, vfd.mustStop ? 1 : 0)
          }
        }
        result.estopPulled = data.zones.length
      }
    }
  } catch (e) {
    console.warn(`[SidePull ${subsystemId}] estop failed:`, e instanceof Error ? e.message : e)
  }

  // ── Safety zones / drives / outputs ───────────────────────────────────────
  // Regression guard: the pull used to DELETE these and never re-insert them.
  try {
    const res = await doFetch(`${base}/api/sync/safety?subsystemId=${subsystemId}&apiKey=${encodeURIComponent(apiPassword)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as {
        success?: boolean
        zones?: Array<{ name: string; stoSignal?: string; bssTag?: string; drives?: Array<{ name: string }> }>
        outputs?: Array<{ tag: string; description?: string; outputType?: string }>
      }
      if (data.success && ((data.zones && data.zones.length > 0) || (data.outputs && data.outputs.length > 0))) {
        db.prepare(`DELETE FROM SafetyZoneDrives WHERE ZoneId IN (SELECT id FROM SafetyZones WHERE SubsystemId = ?)`).run(subsystemId)
        db.prepare('DELETE FROM SafetyZones WHERE SubsystemId = ?').run(subsystemId)
        db.prepare('DELETE FROM SafetyOutputs WHERE SubsystemId = ?').run(subsystemId)
        const insertZone = db.prepare('INSERT INTO SafetyZones (SubsystemId, Name, StoSignal, BssTag) VALUES (?, ?, ?, ?)')
        const insertDrive = db.prepare('INSERT INTO SafetyZoneDrives (ZoneId, Name) VALUES (?, ?)')
        const insertOutput = db.prepare('INSERT INTO SafetyOutputs (SubsystemId, Tag, Description, OutputType) VALUES (?, ?, ?, ?)')
        for (const zone of data.zones || []) {
          const zr = insertZone.run(subsystemId, zone.name, zone.stoSignal || null, zone.bssTag || null)
          const zoneId = zr.lastInsertRowid
          for (const d of zone.drives || []) insertDrive.run(zoneId, d.name)
        }
        for (const o of data.outputs || []) insertOutput.run(subsystemId, o.tag, o.description || null, o.outputType || null)
        result.safetyPulled = (data.zones || []).length
      }
    }
  } catch (e) {
    console.warn(`[SidePull ${subsystemId}] safety failed:`, e instanceof Error ? e.message : e)
  }

  // ── Punchlists ────────────────────────────────────────────────────────────
  try {
    const res = await doFetch(`${base}/api/sync/punchlists?subsystemId=${subsystemId}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = (await res.json()) as { punchlists?: Array<{ id: number; name: string; ioIds?: number[] }> }
      if (data.punchlists && data.punchlists.length > 0) {
        db.prepare(`DELETE FROM PunchlistItems WHERE PunchlistId IN (SELECT id FROM Punchlists WHERE SubsystemId = ?)`).run(subsystemId)
        db.prepare('DELETE FROM Punchlists WHERE SubsystemId = ?').run(subsystemId)
        const insertPunchlist = db.prepare('INSERT OR REPLACE INTO Punchlists (id, Name, SubsystemId) VALUES (?, ?, ?)')
        const insertItem = db.prepare('INSERT OR IGNORE INTO PunchlistItems (PunchlistId, IoId) VALUES (?, ?)')
        for (const pl of data.punchlists) {
          insertPunchlist.run(pl.id, pl.name, subsystemId)
          for (const ioId of pl.ioIds || []) insertItem.run(pl.id, ioId)
          result.punchlistsPulled++
        }
      }
    }
  } catch (e) {
    console.warn(`[SidePull ${subsystemId}] punchlist failed:`, e instanceof Error ? e.message : e)
  }

  return result
}
