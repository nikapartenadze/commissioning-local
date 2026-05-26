/**
 * Network Comms Ring Commissioning — shared types.
 *
 * The feature reads each DPM's embedded Moxa switch directly over SNMP
 * (read-only) and compares the live wiring/health against a saved baseline.
 *
 * Port-identity note: a "port" here is the LLDP *local port number*
 * (lldpRemLocalPortNum) / IF-MIB ifIndex as reported by the switch. We do NOT
 * try to translate it to a faceplate/physical port number. The comparison is
 * self-consistent because the baseline is itself captured from a scan — both
 * the expected and the actual side use the same numbering. The tech reconciles
 * to the physical drawing once, by eye, when saving the baseline.
 */

/**
 * Library-agnostic SNMP varbind. `snmp-client.ts` normalizes net-snmp's
 * varbinds into this shape so the parsers never import net-snmp and stay
 * unit-testable with plain fixtures.
 */
export interface Varbind {
  oid: string;
  value: string | number | Buffer | null;
}

// ── SNMP access ──────────────────────────────────────────────────────────

/** Read-only SNMP v2c access parameters, sourced from AppConfig. */
export interface RingSnmpConfig {
  /** v2c read community string (Moxa default "public"). */
  community: string;
  /** UDP port (default 161). */
  port: number;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Retries per request. */
  retries: number;
}

export const DEFAULT_RING_SNMP: RingSnmpConfig = {
  community: 'public',
  port: 161,
  timeoutMs: 3000,
  retries: 1,
};

/**
 * Modbus/TCP fallback for ring status, used when a switch firmware doesn't
 * expose ring state over SNMP. Read-only FC4 against the registers documented
 * in the Moxa Industrial Protocols guide.
 */
export interface ModbusRingConfig {
  enabled: boolean;
  /** Modbus/TCP port (default 502). */
  port: number;
  /** Modbus unit id (default 1). */
  unitId: number;
  /** Per-read timeout in ms. */
  timeoutMs: number;
}

export const DEFAULT_RING_MODBUS: Omit<ModbusRingConfig, 'enabled'> = {
  port: 502,
  unitId: 1,
  timeoutMs: 3000,
};

// ── Live scan data ───────────────────────────────────────────────────────

/** One LLDP neighbor seen on a local port of a switch. */
export interface LldpNeighbor {
  /** Local port number the neighbor is seen on (lldpRemLocalPortNum). */
  localPort: number;
  /** Normalized remote chassis id (MAC as "aa:bb:.." or the raw string). */
  remoteChassisId: string;
  /** Normalized remote port id. */
  remotePortId: string;
  /** Remote system name, if the neighbor advertises one. */
  remoteSysName?: string;
  /** Remote port description, if advertised. */
  remotePortDesc?: string;
}

/** Per-port interface stats from IF-MIB + EtherLike-MIB. */
export interface RingPortStat {
  /** Port number == ifIndex. */
  port: number;
  /** ifOperStatus == up. */
  linkUp: boolean;
  /** Current speed in Mbps (0 = unknown). Prefers ifHighSpeed, falls back to ifSpeed. */
  speedMbps: number;
  /** dot3StatsDuplexStatus: true=full, false=half, null=unknown/not present. */
  fullDuplex: boolean | null;
  /** ifInErrors (cumulative). */
  inErrors: number;
  /** ifOutErrors (cumulative). */
  outErrors: number;
  /** dot3StatsFCSErrors (cumulative). */
  fcsErrors: number;
  /** dot3StatsAlignmentErrors (cumulative). */
  alignmentErrors: number;
}

export type RingHealth = 'healthy' | 'broken' | 'unknown' | 'not-enabled';
export type RingRole = 'master' | 'slave' | 'unknown' | 'not-enabled';

/** Redundancy/ring status of one switch. */
export interface RingStatus {
  /** Human label, e.g. "Turbo Ring V2", "RSTP", "None", "unknown". */
  protocol: string;
  health: RingHealth;
  role: RingRole;
}

/** Result of scanning one DPM's switch. */
export interface DpmScan {
  dpmName: string;
  ip: string;
  /** False when SNMP did not respond. The scan still completes for other DPMs. */
  reachable: boolean;
  /** Populated when reachable=false. */
  error?: string;
  /** Switch sysName (used to resolve neighbor identity when present). */
  sysName?: string;
  /** This switch's own LLDP chassis id — the robust key to match neighbors against. */
  localChassisId?: string;
  neighbors: LldpNeighbor[];
  ports: RingPortStat[];
  ring: RingStatus;
  scannedAt: number;
}

/** Full ring scan across all DPMs. */
export interface RingScanResult {
  ringId: number;
  ringName: string;
  scannedAt: number;
  dpms: DpmScan[];
}

// ── Baseline (the "expected" wiring) ──────────────────────────────────────

/** One expected inter-DPM ring link (directional; stored once per local side). */
export interface BaselineLink {
  localDpm: string;
  localPort: number;
  remoteDpm: string;
  remotePort: number;
  /** Expected negotiated speed for this uplink, if known. */
  expectedSpeedMbps?: number;
  /** Expected duplex, if known. */
  expectedFullDuplex?: boolean;
}

/** Saved expected topology for a ring. */
export interface RingBaseline {
  ringId: number;
  links: BaselineLink[];
  /** chassis-id → DPM name, captured at baseline time for identity when sysName is absent. */
  chassisToDpm: Record<string, string>;
  savedBy?: string;
  savedAt: number;
}

// ── Report (output of compare) ────────────────────────────────────────────

export type CheckState = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckItem {
  state: CheckState;
  message: string;
}

/** Result of checking one expected (or observed) ring link. */
export interface LinkCheck {
  localDpm: string;
  localPort: number;
  expectedRemoteDpm?: string;
  expectedRemotePort?: number;
  actualRemoteDpm?: string;
  actualRemotePort?: number;
  state: CheckState;
  message: string;
}

/** Termination quality of one ring port. */
export interface PortTerminationCheck {
  dpm: string;
  port: number;
  linkUp: boolean;
  speedMbps: number;
  expectedSpeedMbps?: number;
  fullDuplex: boolean | null;
  errorsTotal: number;
  state: CheckState;
  message: string;
}

export interface DpmReport {
  dpmName: string;
  ip: string;
  reachable: boolean;
  ringHealth: CheckItem;
  links: LinkCheck[];
  terminations: PortTerminationCheck[];
}

export interface RingCheckReport {
  ringId: number;
  ringName: string;
  generatedAt: number;
  /** False on the first run (no baseline yet) — topology checks are skipped and surfaced for review. */
  hasBaseline: boolean;
  overall: CheckState;
  reachability: CheckItem;
  dpms: DpmReport[];
  summary: { pass: number; fail: number; warn: number; skip: number };
}
