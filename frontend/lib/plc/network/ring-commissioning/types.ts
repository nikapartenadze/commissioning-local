/**
 * Ring-commissioning domain types (pure; no I/O).
 *
 * Shared vocabulary for the on-demand ring wiring check: switch->switch links
 * (from LLDP), leaf-device placement (from the bridge FDB), per-port termination
 * health (from the existing CIP 0xF6 read), and the ring open/closed verdict
 * (from DLR or a vendor MIB). A captured RingTopology is compared against an
 * operator-approved RingBaseline. See specs/2026-07-08-network-ring-commissioning-design.md.
 */

/** One directed switch->switch cable as seen by LLDP: localPort on localDevice
 *  connects to remotePort on remoteDevice. */
export interface SwitchLink {
  localDevice: string
  localPort: number
  remoteDevice: string
  remotePort: number
}

/** A leaf (non-switch) device placed on a switch port, from the bridge FDB. */
export interface LeafPlacement {
  device: string
  switchName: string
  port: number
}

/** Per-port termination health, sourced from the existing CIP 0xF6 diagnostics. */
export interface PortTermination {
  device: string
  port: number
  linkUp: boolean
  speedMbps: number
  fullDuplex: boolean
  mediaErrors: boolean
}

/** Ring open/closed verdict + provenance (DLR, Moxa Turbo Ring, MRP, or none). */
export interface RingState {
  closed: boolean
  source: 'dlr' | 'moxa' | 'mrp' | 'none'
  reason: string
  /** On an open ring, the two nodes bracketing the break, when localizable. */
  breakBetween?: [string, string]
}

/** A full ring read — a captured "actual", or a stored baseline's topology. */
export interface RingTopology {
  links: SwitchLink[]
  leaves: LeafPlacement[]
  terminations: PortTermination[]
  ring: RingState
}

/** An operator-approved golden baseline for one ring. */
export interface RingBaseline {
  subsystemId: number
  ringName: string
  capturedAt: string
  approvedBy: string | null
  approvedAt: string | null
  topology: RingTopology
}
