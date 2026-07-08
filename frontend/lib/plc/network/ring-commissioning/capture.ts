/**
 * Capture orchestration: assemble an "actual" RingTopology for a ring from
 * SNMP LLDP + FDB reads (per switch), the existing DLR ring read (when a
 * supervisor is present), and existing CIP 0xF6 terminations.
 *
 * `assembleTopology` is pure (unit-tested). `captureRing` wires the real
 * readers but takes every side-read via injected `CaptureDeps`, so it stays
 * isolated and testable, and — like the whole feature — never throws: a dead
 * switch yields fewer links, and a total read failure returns { ok:false }.
 */
import type { RingTopology, SwitchLink, LeafPlacement, PortTermination, RingState } from './types'
import type { SnmpCreds, SnmpReadResult } from './snmp/client'
import { snmpWalk } from './snmp/client'
import { OID } from './snmp/mibs'
import { parseLldpNeighbors, parseFdb } from './snmp/parse'
import { selectVendor, decodeRingState } from './snmp/adapters'

export interface SwitchTarget { name: string; ip: string; vendorHint?: string }
export interface CaptureInputs { links: SwitchLink[]; leaves: LeafPlacement[]; terminations: PortTermination[]; ring: RingState }

/** Injected side-reads so captureRing stays isolated + testable. */
export interface CaptureDeps {
  /** Resolve an LLDP chassis-id to a known device name (from NetworkNodes). */
  resolveChassis: (chassisId: string) => string
  /** Resolve a learned MAC to a known leaf device, or null. */
  resolveMac: (mac: string) => string | null
  /** Bridge-port -> physical-port map per switch (empty => identity). */
  portIfIndex: (switchName: string) => Map<number, number>
  /** The DLR ring result if a supervisor is present (else null). */
  dlrRing: RingState | null
  /** Existing 0xF6-derived terminations for the ring's ports. */
  terminations: () => PortTermination[]
  /** Override the SNMP walk (tests inject fakes). */
  walk?: (host: string, oid: string, creds: SnmpCreds) => Promise<SnmpReadResult>
}

function dedupeLinks(links: SwitchLink[]): SwitchLink[] {
  const seen = new Set<string>()
  const out: SwitchLink[] = []
  for (const l of links) {
    const key = [`${l.localDevice}:${l.localPort}`, `${l.remoteDevice}:${l.remotePort}`].sort().join('=')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}

/** Pure assembly: dedupe reverse-direction links, pass through the rest. */
export function assembleTopology(i: CaptureInputs): RingTopology {
  return { links: dedupeLinks(i.links), leaves: i.leaves, terminations: i.terminations, ring: i.ring }
}

export async function captureRing(
  switches: SwitchTarget[], creds: SnmpCreds, deps: CaptureDeps,
): Promise<{ ok: true; topology: RingTopology } | { ok: false; reason: string }> {
  const walk = deps.walk ?? snmpWalk
  const links: SwitchLink[] = []
  const leaves: LeafPlacement[] = []
  let anyRead = false
  let vendorRingRows: { vendor: ReturnType<typeof selectVendor>; rows: SnmpReadResult } | null = null

  for (const sw of switches) {
    const lldp = await walk(sw.ip, OID.lldpRemChassisId, creds)
    const lldpPorts = await walk(sw.ip, OID.lldpRemPortId, creds)
    if (lldp.available && lldpPorts.available) {
      anyRead = true
      links.push(...parseLldpNeighbors([...lldp.rows, ...lldpPorts.rows], sw.name, deps.resolveChassis))
    }
    const fdb = await walk(sw.ip, OID.dot1dTpFdbPort, creds)
    if (fdb.available) {
      anyRead = true
      leaves.push(...parseFdb(fdb.rows, sw.name, deps.portIfIndex(sw.name), deps.resolveMac))
    }
    // Read vendor ring-state from the first switch only (single-point read).
    if (!vendorRingRows) {
      const vendor = selectVendor(sw.name, sw.vendorHint)
      if (vendor === 'hirschmann') vendorRingRows = { vendor, rows: await walk(sw.ip, OID.hmMrpMRMRealRingState, creds) }
      else if (vendor === 'moxa' && OID.moxaTurboRingState) vendorRingRows = { vendor, rows: await walk(sw.ip, OID.moxaTurboRingState, creds) }
      else vendorRingRows = { vendor, rows: { available: true, rows: [] } }
    }
  }

  // Ring verdict: prefer DLR (already proven); else the vendor MIB.
  const ring: RingState = deps.dlrRing
    ?? (vendorRingRows
      ? decodeRingState(vendorRingRows.vendor, vendorRingRows.rows.available ? vendorRingRows.rows.rows : [])
      : { closed: false, source: 'none', reason: 'No ring source' })

  if (!anyRead && !deps.dlrRing) {
    return { ok: false, reason: 'No switch responded to SNMP and no DLR supervisor present — check SNMP config/reachability, or run on-site.' }
  }
  return { ok: true, topology: assembleTopology({ links, leaves, terminations: deps.terminations(), ring }) }
}
