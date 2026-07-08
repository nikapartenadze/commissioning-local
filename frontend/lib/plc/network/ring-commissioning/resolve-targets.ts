/**
 * Build ring-commissioning capture targets for a subsystem from the locally
 * stored network topology (NetworkRings/NetworkNodes). Switch IPs come from
 * NetworkNodes; the resolver closures map LLDP chassis-ids and FDB MACs back to
 * known device names. Takes the db connection as a parameter (testable).
 */
import type { Database } from 'better-sqlite3'
import type { SwitchTarget } from './capture'

interface NodeRow { id: number; Name: string; IpAddress: string | null }
interface RingRow { id: number; Name: string }

export interface RingTargets {
  ringName: string
  switches: SwitchTarget[]
  resolveChassis: (chassisId: string) => string
  resolveMac: (mac: string) => string | null
}

/**
 * One entry per NetworkRing in the subsystem. `resolveChassis` matches an LLDP
 * neighbor identity to a node whose name or IP it embeds (best-effort, refined
 * on hardware). `resolveMac` returns null in Phase 1 — no MAC inventory exists
 * yet, so FDB leaf placement stays empty until a MAC source is added; the
 * switch->switch LLDP verification is unaffected. Documented gap in the spec.
 */
export function resolveSwitchTargets(db: Database, subsystemId: number): RingTargets[] {
  const rings = db.prepare('SELECT id, Name FROM NetworkRings WHERE SubsystemId=?').all(subsystemId) as RingRow[]
  return rings.map((ring) => {
    const nodes = db.prepare('SELECT id, Name, IpAddress FROM NetworkNodes WHERE RingId=?').all(ring.id) as NodeRow[]
    const switches: SwitchTarget[] = nodes
      .filter(n => !!n.IpAddress)
      .map(n => ({ name: n.Name, ip: n.IpAddress as string }))
    const resolveChassis = (chassisId: string): string => {
      const hit = nodes.find(n => chassisId.includes(n.Name) || (n.IpAddress != null && chassisId.includes(n.IpAddress)))
      return hit ? hit.Name : chassisId
    }
    const resolveMac = (_mac: string): string | null => null
    return { ringName: ring.Name, switches, resolveChassis, resolveMac }
  })
}
