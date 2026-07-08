/**
 * Pure parsers: turn raw SNMP walk rows (OID + value) into ring-commissioning
 * domain objects. No network I/O — fed fixture rows in tests. See parse test.
 */
import type { SwitchLink, LeafPlacement } from '../types'
import { OID } from './mibs'

export interface SnmpRow { oid: string; value: string }

/** Strip a base OID prefix and return the trailing index numbers ([] if no match). */
function indexOf(oid: string, base: string): number[] {
  if (!oid.startsWith(base + '.')) return []
  return oid.slice(base.length + 1).split('.').map(Number)
}

/**
 * The LLDP remote table is indexed .<timeMark>.<lldpLocPortNum>.<lldpRemIndex>.
 * We pair lldpRemChassisId (the neighbor's identity) with lldpRemPortId (the
 * neighbor's port) at the same index, resolve the chassis id to a known device
 * name, and emit one SwitchLink per neighbor entry.
 */
export function parseLldpNeighbors(
  rows: SnmpRow[], localDevice: string, resolveChassis: (chassisId: string) => string,
): SwitchLink[] {
  const chassis = new Map<string, string>()
  const remPort = new Map<string, string>()
  for (const r of rows) {
    const ci = indexOf(r.oid, OID.lldpRemChassisId)
    if (ci.length === 3) { chassis.set(ci.join('.'), r.value); continue }
    const pi = indexOf(r.oid, OID.lldpRemPortId)
    if (pi.length === 3) remPort.set(pi.join('.'), r.value)
  }
  const links: SwitchLink[] = []
  for (const [idx, chassisId] of chassis) {
    const localPort = Number(idx.split('.')[1])
    const remotePortRaw = remPort.get(idx)
    const remotePort = remotePortRaw != null ? Number(remotePortRaw) : NaN
    if (!Number.isFinite(localPort) || !Number.isFinite(remotePort)) continue
    links.push({ localDevice, localPort, remoteDevice: resolveChassis(chassisId), remotePort })
  }
  return links
}

/** Format the 6 trailing index bytes of a dot1dTpFdbPort OID as a MAC string. */
function macFromIndex(idx: number[]): string {
  return idx.slice(-6).map(b => b.toString(16).padStart(2, '0')).join(':')
}

/**
 * dot1dTpFdbPort is indexed by the 6-byte learned MAC (decimal), value = bridge
 * port. We map bridge port -> physical port via portIfIndex, resolve the MAC to
 * a known device, and emit one LeafPlacement per resolvable entry. MACs that
 * resolve to no known device are dropped.
 */
export function parseFdb(
  rows: SnmpRow[], switchName: string, portIfIndex: Map<number, number>,
  resolveMac: (mac: string) => string | null,
): LeafPlacement[] {
  const out: LeafPlacement[] = []
  for (const r of rows) {
    const idx = indexOf(r.oid, OID.dot1dTpFdbPort)
    if (idx.length < 6) continue
    const bridgePort = Number(r.value)
    const phys = portIfIndex.get(bridgePort) ?? bridgePort
    const device = resolveMac(macFromIndex(idx))
    if (!device) continue
    out.push({ device, switchName, port: phys })
  }
  return out
}
