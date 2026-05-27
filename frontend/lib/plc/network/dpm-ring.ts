/**
 * DPM (Hirschmann Octopus OS30) ring health — derived from the per-port link
 * data we already poll for each DPM switch (no SNMP needed).
 *
 * This is a LINK-LEVEL view of the Hirschmann backbone ring: it flags a DPM
 * switch whose port carried traffic and then lost link (a broken ring segment)
 * or reports a hardware fault. It does NOT read the MRP "redundancy intact"
 * state (that lives only in SNMP on the OS30 — a future refinement); but a
 * physically broken ring link drops a port, which this catches.
 *
 * Pure + unit-tested (__tests__/dpm-ring.test.ts). Operates on the per-device
 * snapshot shape produced by the network poller / broadcast over WS.
 */

export interface DpmPort {
  portNumber: number
  linkUp: boolean
  hardwareFault: boolean
  octetsIn: number
  octetsOut: number
}

export interface DpmDevice {
  deviceName: string
  ports: readonly DpmPort[]
}

export interface DpmRingIssue {
  deviceName: string
  detail: string
}

export interface DpmRingSummary {
  state: 'healthy' | 'degraded' | 'unknown'
  /** Number of DPM (OS30) switches seen. */
  switchCount: number
  issues: DpmRingIssue[]
}

/** True for Hirschmann Octopus "DPM" switch device names (e.g. UL29_8_DPM1). */
export function isDpmSwitch(name: string): boolean {
  return /DPM/i.test(name)
}

/** A port that carried traffic and then lost link — i.e. a real, in-use link
 *  that went down (a broken ring/uplink), as opposed to an unused spare port. */
function portActivelyDown(p: DpmPort): boolean {
  return !p.linkUp && (p.octetsIn > 0 || p.octetsOut > 0)
}

/**
 * Summarise DPM (OS30) ring health from device snapshots.
 *   - unknown: no DPM switches in the data (can't judge).
 *   - degraded: a DPM switch has an actively-down port or a hardware fault.
 *   - healthy: DPM switches present, all in-use ports up, no faults.
 */
export function summarizeDpmRing(devices: readonly DpmDevice[]): DpmRingSummary {
  const dpms = devices.filter((d) => isDpmSwitch(d.deviceName))
  if (dpms.length === 0) return { state: 'unknown', switchCount: 0, issues: [] }

  const issues: DpmRingIssue[] = []
  for (const d of dpms) {
    const down = d.ports.filter(portActivelyDown).map((p) => p.portNumber)
    const faulted = d.ports.filter((p) => p.hardwareFault).map((p) => p.portNumber)
    if (down.length > 0) {
      issues.push({ deviceName: d.deviceName, detail: `link down on port${down.length > 1 ? 's' : ''} ${down.join(', ')}` })
    } else if (faulted.length > 0) {
      issues.push({ deviceName: d.deviceName, detail: `hardware fault on port${faulted.length > 1 ? 's' : ''} ${faulted.join(', ')}` })
    }
  }
  return { state: issues.length > 0 ? 'degraded' : 'healthy', switchCount: dpms.length, issues }
}
