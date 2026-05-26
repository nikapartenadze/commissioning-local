/**
 * Configuration Types
 *
 * TypeScript interfaces matching the C# backend configuration structure.
 * Based on backend/config.json schema.
 */

/**
 * Application configuration matching config.json structure.
 * This is the core configuration for PLC connection and cloud sync.
 */
export interface AppConfig {
  /** PLC IP address (e.g., "192.168.1.100") */
  ip: string;

  /** PLC path for Ethernet/IP routing (e.g., "1,0") */
  path: string;

  /** Remote cloud server URL for syncing — always EMBEDDED_REMOTE_URL at runtime; stored value is ignored */
  remoteUrl: string;

  /** API password for cloud authentication */
  apiPassword: string;

  /** Subsystem ID for filtering IOs */
  subsystemId: string;

  /** Optional release manifest URL for host-side update checks */
  updateManifestUrl?: string;

  /** Order mode: "0" = test any order, "1" = sequential testing */
  orderMode: string;

  /** Number of records per cloud sync batch */
  syncBatchSize: number;

  /** Delay in milliseconds between sync batches */
  syncBatchDelayMs: number;

  /** Pre-configured PLC profiles for quick subsystem switching */
  plcProfiles?: PlcProfile[];

  /**
   * Optional explicit device-name list used as a fallback when the PLC's
   * @tags browse is locked down or returns no matches. Each name is probed
   * against the known suffixes (_NetworkNode, _NN.Data, _NN). The network
   * poller always runs at PLC connect — this field is just a safety net for
   * locked-down PLCs.
   */
  networkPollingDevices?: string[];

  /**
   * Per-machine opt-in gate (default off / undefined). When true, the server
   * rejects Pass/Fail attempts on any IO whose InstallationStatus is not
   * 'complete' (SPARE IOs exempt). Used on projects like CDW5 where mechanical
   * installation must be signed off before IO testing is allowed. Flipping
   * this in config.json hot-reloads — no restart needed.
   */
  requireInstalledForTesting?: boolean;

  /**
   * UDT_NETWORK_NODE_DATA polling cadence in milliseconds. Optional; defaults
   * to 60_000 ms (one poll per minute). Reduce to 5_000 only for active
   * field debugging — every poll queues N parallel CIP requests against
   * the same controller that the IO tag reader is hammering, so a fast
   * cadence steals CIP slots and makes the IO grid feel laggy. The cloud
   * heartbeat downsamples to 60 s regardless, so faster polling does not
   * give the cloud fresher data.
   */
  networkPollingIntervalMs?: number;

  /**
   * Ring Commissioning settings. The feature reads each DPM's embedded Moxa
   * switch directly over read-only SNMP v2c. All fields optional — sensible
   * defaults (community "public", port 161) apply when omitted.
   */
  ring?: RingConfig;
}

/** Ring Commissioning configuration (see lib/network/ring/). */
export interface RingConfig {
  /** SNMP v2c read community (default "public"). */
  snmpCommunity?: string;
  /** SNMP UDP port (default 161). */
  snmpPort?: number;
  /** Per-request timeout in ms (default 3000). */
  snmpTimeoutMs?: number;
  /** Retries per request (default 1). */
  snmpRetries?: number;
  /**
   * Moxa private-MIB scalar OIDs for ring redundancy state. Resolve these
   * against the actual switch model during field validation; when absent, ring
   * health reports "unknown" and the rest of the check still runs.
   */
  moxaOids?: {
    protocol?: string;
    ringStatus?: string;
    masterSlave?: string;
  };
  /**
   * Modbus/TCP fallback for ring status, used when SNMP doesn't expose ring
   * state on a given firmware. Reads the documented Moxa ring registers
   * (0x3000/0x3300/0x3600) read-only.
   */
  modbus?: {
    enabled?: boolean;
    port?: number;
    unitId?: number;
    timeoutMs?: number;
  };
  /**
   * Optional management-IP overrides per DPM name, for when the Moxa switch's
   * management interface differs from the DPM's EtherNet/IP address.
   */
  ipOverrides?: Record<string, string>;
  /**
   * Whether to also SNMP-scan the MCM (the Rockwell EN module that closes the
   * ring loop). Off by default because it's typically not an SNMP-managed Moxa
   * switch and would otherwise show as unreachable. Enable only on sites where
   * the MCM-side switch answers SNMP.
   */
  includeMcm?: boolean;
}

/**
 * Extended configuration with column visibility settings.
 * Used for UI state persistence.
 */
export interface AppConfigExtended extends AppConfig {
  /** Show state column in IO table */
  showStateColumn?: boolean;

  /** Show result column in IO table */
  showResultColumn?: boolean;

  /** Show timestamp column in IO table */
  showTimestampColumn?: boolean;

  /** Show history column in IO table */
  showHistoryColumn?: boolean;
}

/**
 * Configuration update request (partial config).
 * All fields are optional to allow partial updates.
 */
export interface ConfigUpdateRequest {
  ip?: string;
  path?: string;
  remoteUrl?: string;
  apiPassword?: string;
  subsystemId?: string;
  updateManifestUrl?: string;
  orderMode?: string;
  syncBatchSize?: number;
  syncBatchDelayMs?: number;
  showStateColumn?: boolean;
  showResultColumn?: boolean;
  showTimestampColumn?: boolean;
  showHistoryColumn?: boolean;
  requireInstalledForTesting?: boolean;
  networkPollingIntervalMs?: number;
}

/**
 * PLC connection request.
 * Used when connecting to PLC with specific IP and path.
 */
export interface PlcConnectRequest {
  ip: string;
  path: string;
  subsystemId?: string;
  remoteUrl?: string;
  apiPassword?: string;
  orderMode?: boolean;
  showStateColumn?: boolean;
  showResultColumn?: boolean;
  showTimestampColumn?: boolean;
  showHistoryColumn?: boolean;
  /** Comma-separated patterns to exclude from PLC tag validation */
  excludePatterns?: string;
}

/**
 * Embedded cloud server URL. Single source of truth — the field tool always
 * talks to this host, regardless of what's stored in config.json. The Remote
 * URL field was removed from the UI to prevent operator misconfiguration.
 */
export const EMBEDDED_REMOTE_URL = 'https://commissioning.autstand.com';

/**
 * Default configuration values.
 * Used when config.json doesn't exist or has missing fields.
 */
export const DEFAULT_CONFIG: AppConfig = {
  ip: '',
  path: '1,0',
  remoteUrl: EMBEDDED_REMOTE_URL,
  apiPassword: '',
  subsystemId: '',
  updateManifestUrl: '',
  orderMode: '0',
  syncBatchSize: 50,
  syncBatchDelayMs: 500,
};

/**
 * PLC profile for quick subsystem switching.
 * Pre-configured with PLC IP, path, cloud settings per subsystem.
 */
export interface PlcProfile {
  /** Display name (e.g., "MCM09") */
  name: string;
  /** Subsystem ID in the cloud */
  subsystemId: string;
  /** PLC IP address */
  plcIp: string;
  /** PLC communication path */
  plcPath: string;
}

/**
 * Configuration change event type.
 */
export type ConfigChangeEvent = {
  previousConfig: AppConfig | null;
  currentConfig: AppConfig;
  changedFields: (keyof AppConfig)[];
};

/**
 * Configuration change listener function type.
 */
export type ConfigChangeListener = (event: ConfigChangeEvent) => void;
