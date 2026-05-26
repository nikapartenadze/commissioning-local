/**
 * SNMP OIDs used by ring commissioning.
 *
 * LLDP-MIB and IF-MIB / EtherLike-MIB are standard (IEEE 802.1AB, RFC 2863,
 * RFC 3635) and identical across vendors. The Moxa Turbo Ring status lives in
 * Moxa's private enterprise subtree (8691); the exact leaf OIDs differ by
 * product line and firmware, so they are treated as configurable and resolved
 * against real hardware during field validation. The interpreter
 * (`ring-status.ts`) maps the fetched numeric codes using the SAME encodings
 * documented in the Moxa Industrial Protocols guide's Modbus map, which is the
 * authoritative reference we have.
 */

// ── LLDP-MIB: lldpRemTable (1.0.8802.1.1.2.1.4.1.1) ───────────────────────
// Row index = lldpRemTimeMark.lldpRemLocalPortNum.lldpRemIndex
export const LLDP_REM = {
  CHASSIS_ID: '1.0.8802.1.1.2.1.4.1.1.5',
  PORT_ID: '1.0.8802.1.1.2.1.4.1.1.7',
  PORT_DESC: '1.0.8802.1.1.2.1.4.1.1.8',
  SYS_NAME: '1.0.8802.1.1.2.1.4.1.1.9',
} as const;

// ── IF-MIB ────────────────────────────────────────────────────────────────
export const IF_MIB = {
  /** ifOperStatus: 1=up, 2=down, ... (1.3.6.1.2.1.2.2.1.8) */
  OPER_STATUS: '1.3.6.1.2.1.2.2.1.8',
  /** ifSpeed in bits/s (1.3.6.1.2.1.2.2.1.5) — caps at ~4Gbps; prefer HIGH_SPEED. */
  SPEED: '1.3.6.1.2.1.2.2.1.5',
  /** ifInErrors (1.3.6.1.2.1.2.2.1.14) */
  IN_ERRORS: '1.3.6.1.2.1.2.2.1.14',
  /** ifOutErrors (1.3.6.1.2.1.2.2.1.20) */
  OUT_ERRORS: '1.3.6.1.2.1.2.2.1.20',
  /** ifHighSpeed in Mbps (ifXTable, 1.3.6.1.2.1.31.1.1.1.15) */
  HIGH_SPEED: '1.3.6.1.2.1.31.1.1.1.15',
} as const;

// ── EtherLike-MIB: dot3StatsTable (1.3.6.1.2.1.10.7.2.1) ──────────────────
export const ETHERLIKE = {
  ALIGNMENT_ERRORS: '1.3.6.1.2.1.10.7.2.1.2',
  FCS_ERRORS: '1.3.6.1.2.1.10.7.2.1.3',
  /** dot3StatsDuplexStatus: 1=unknown, 2=halfDuplex, 3=fullDuplex */
  DUPLEX_STATUS: '1.3.6.1.2.1.10.7.2.1.19',
} as const;

// ── System ─────────────────────────────────────────────────────────────────
export const SYS_NAME = '1.3.6.1.2.1.1.5.0';

// ── Moxa private (Turbo Ring) — enterprise 8691 ───────────────────────────
// Defaults below are best-effort; resolve/override against the target switch
// model during field validation (see RING-COMMISSIONING-TEST-PLAN.md).
export const MOXA_ENTERPRISE = '1.3.6.1.4.1.8691';

/** Configurable scalar OIDs for ring state. Any may be absent on a given model. */
export interface MoxaRingOids {
  /** Redundancy protocol code (see RING_PROTOCOL). */
  protocol?: string;
  /** Ring health code (0=healthy, 1=break). */
  ringStatus?: string;
  /** Master/slave code (0=slave, 1=master). */
  masterSlave?: string;
}

/**
 * Value encodings, identical to the Moxa Industrial Protocols guide Modbus map.
 */
export const RING_PROTOCOL: Record<number, string> = {
  0: 'None',
  1: 'RSTP',
  2: 'Turbo Ring',
  3: 'Turbo Ring V2',
  4: 'Turbo Chain',
  5: 'MSTP',
  16: 'MRP',
};

/** Turbo Ring (V2) status code. */
export const RING_STATUS_CODE = {
  HEALTHY: 0,
  BREAK: 1,
} as const;

/** Turbo Ring master/slave code. */
export const RING_MASTER_CODE = {
  SLAVE: 0,
  MASTER: 1,
} as const;
