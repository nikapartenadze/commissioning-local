/**
 * Ring-commissioning verdict engine (PURE; no I/O; fully unit-tested).
 *
 * Compares a captured RingTopology against an operator-approved baseline and
 * classifies every switch->switch link and leaf placement, folds in per-port
 * termination faults, and produces an overall healthy/degraded verdict. This is
 * the heart of the feature and is correct regardless of hardware.
 */
import type { RingTopology, SwitchLink, LeafPlacement, PortTermination } from './types'

export type LinkVerdictKind =
  | 'match' | 'wrong-port' | 'wrong-neighbor' | 'missing' | 'unexpected' | 'termination-fault'

export interface LinkVerdict {
  kind: LinkVerdictKind
  expected?: SwitchLink | LeafPlacement
  actual?: SwitchLink | LeafPlacement
  detail: string
}

export interface RingCommissioningVerdict {
  healthy: boolean
  ringClosed: boolean
  ringReason: string
  links: LinkVerdict[]
  leafVerdicts: LinkVerdict[]
  terminationFaults: LinkVerdict[]
}

/** Undirected exact key so DPM1:3<->DPM2:1 matches regardless of read direction. */
function linkKey(l: SwitchLink): string {
  const a = `${l.localDevice}:${l.localPort}`
  const b = `${l.remoteDevice}:${l.remotePort}`
  return [a, b].sort().join('=')
}
/** Neighbor-only key (ignores ports) to detect right-neighbor/wrong-port. */
function neighborKey(l: SwitchLink): string {
  return [l.localDevice, l.remoteDevice].sort().join('=')
}

function diffLinks(expected: SwitchLink[], actual: SwitchLink[]): LinkVerdict[] {
  const out: LinkVerdict[] = []
  const actualByExact = new Map(actual.map(l => [linkKey(l), l]))
  const actualByNeighbor = new Map(actual.map(l => [neighborKey(l), l]))
  const consumedActual = new Set<string>()

  for (const exp of expected) {
    const exact = actualByExact.get(linkKey(exp))
    if (exact) {
      consumedActual.add(linkKey(exact))
      out.push({ kind: 'match', expected: exp, actual: exact, detail: `${exp.localDevice}:${exp.localPort} <-> ${exp.remoteDevice}:${exp.remotePort}` })
      continue
    }
    const byNeighbor = actualByNeighbor.get(neighborKey(exp))
    if (byNeighbor && !consumedActual.has(linkKey(byNeighbor))) {
      consumedActual.add(linkKey(byNeighbor))
      out.push({ kind: 'wrong-port', expected: exp, actual: byNeighbor, detail: `${exp.localDevice}<->${exp.remoteDevice}: drawn ${exp.localPort}/${exp.remotePort}, found ${byNeighbor.localPort}/${byNeighbor.remotePort}` })
      continue
    }
    out.push({ kind: 'missing', expected: exp, detail: `no cable found for ${exp.localDevice}:${exp.localPort} <-> ${exp.remoteDevice}:${exp.remotePort}` })
  }

  // Set of every drawn endpoint (device:port). An unconsumed actual link that
  // occupies a drawn endpoint but goes somewhere else is a WRONG-NEIGHBOR (that
  // exact port was drawn to a different device); one on a port the drawing never
  // used is simply UNEXPECTED (an extra cable).
  const drawnEndpoints = new Set<string>()
  for (const e of expected) {
    drawnEndpoints.add(`${e.localDevice}:${e.localPort}`)
    drawnEndpoints.add(`${e.remoteDevice}:${e.remotePort}`)
  }
  for (const act of actual) {
    if (consumedActual.has(linkKey(act))) continue
    const occupiesDrawnPort =
      drawnEndpoints.has(`${act.localDevice}:${act.localPort}`) ||
      drawnEndpoints.has(`${act.remoteDevice}:${act.remotePort}`)
    out.push(occupiesDrawnPort
      ? { kind: 'wrong-neighbor', actual: act, detail: `${act.localDevice}:${act.localPort} goes to ${act.remoteDevice}:${act.remotePort}, not the drawn neighbor` }
      : { kind: 'unexpected', actual: act, detail: `unexpected cable ${act.localDevice}:${act.localPort} <-> ${act.remoteDevice}:${act.remotePort}` })
  }
  return out
}

function leafKey(l: LeafPlacement): string { return `${l.device}` }

function diffLeaves(expected: LeafPlacement[], actual: LeafPlacement[]): LinkVerdict[] {
  const out: LinkVerdict[] = []
  const actualByDevice = new Map(actual.map(l => [leafKey(l), l]))
  const seen = new Set<string>()
  for (const exp of expected) {
    const act = actualByDevice.get(leafKey(exp))
    if (!act) { out.push({ kind: 'missing', expected: exp, detail: `${exp.device} not found on any switch port` }); continue }
    seen.add(leafKey(act))
    if (act.switchName === exp.switchName && act.port === exp.port) {
      out.push({ kind: 'match', expected: exp, actual: act, detail: `${exp.device} on ${exp.switchName}:${exp.port}` })
    } else {
      out.push({ kind: 'wrong-port', expected: exp, actual: act, detail: `${exp.device}: drawn ${exp.switchName}:${exp.port}, found ${act.switchName}:${act.port}` })
    }
  }
  for (const act of actual) {
    if (!seen.has(leafKey(act))) out.push({ kind: 'unexpected', actual: act, detail: `unexpected device ${act.device} on ${act.switchName}:${act.port}` })
  }
  return out
}

function terminationFaults(terms: PortTermination[]): LinkVerdict[] {
  return terms
    .filter(t => t.linkUp && (t.mediaErrors || !t.fullDuplex || (t.speedMbps > 0 && t.speedMbps < 100)))
    .map(t => ({
      kind: 'termination-fault' as const,
      detail: `${t.device}:${t.port} — ${[t.mediaErrors && 'media errors', !t.fullDuplex && 'half-duplex', t.speedMbps > 0 && t.speedMbps < 100 && `${t.speedMbps}Mbps`].filter(Boolean).join(', ')}`,
    }))
}

export function compareTopology(baseline: RingTopology, actual: RingTopology): RingCommissioningVerdict {
  const links = diffLinks(baseline.links, actual.links)
  const leafVerdicts = diffLeaves(baseline.leaves, actual.leaves)
  const tFaults = terminationFaults(actual.terminations)
  const ringClosed = actual.ring.closed
  const badLink = links.some(l => l.kind !== 'match') || leafVerdicts.some(l => l.kind !== 'match')
  const healthy = ringClosed && !badLink && tFaults.length === 0
  return {
    healthy,
    ringClosed,
    ringReason: actual.ring.reason,
    links,
    leafVerdicts,
    terminationFaults: tFaults,
  }
}
