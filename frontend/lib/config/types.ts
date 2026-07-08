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
   * Backplane path to the DLR ring supervisor (the 1756-EN2TR/EN4TR), e.g.
   * "1,2" (backplane port 1, slot 2). Drives the DLR ring-health indicator.
   * When omitted, the poller derives it from a discovered SLOTn_EN4TR device
   * name; set this explicitly when the EN4TR isn't named SLOTn_EN4TR or sits
   * in a different slot. No path resolvable → ring status shows Unknown.
   */
  dlrSupervisorPath?: string;

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
   * Subsystem ID of the last PLC the tool *successfully* connected to. Used
   * by the boot-time auto-connect to decide whether the stored `ip`/`path`
   * still describes the same site. If `subsystemId` (the active selection)
   * matches this value, auto-connect on startup; otherwise wait for the
   * operator to pick an MCM in the UI. Prevents silently connecting to a
   * different PLC that happens to live on the same IP at a different site.
   */
  lastConnectedSubsystemId?: string;

  /**
   * ISO timestamp of the last successful PLC connect. Diagnostic only —
   * boot-time auto-connect doesn't gate on this, but it helps the UI
   * surface "last connected …" hints when reconnect fails.
   */
  lastConnectedAt?: string;

  /**
   * Central-tool multi-MCM configuration. When present, the server exposes
   * each entry at `/api/mcm/:subsystemId/...` and the new landing page lists
   * them all. The legacy `ip`/`path`/`subsystemId` fields remain authoritative
   * for the field-laptop single-MCM flow and continue to mirror the first
   * enabled entry for backwards compatibility.
   */
  mcms?: McmConnection[];

  /**
   * Optional SharePoint (Microsoft Graph, app-only client-credentials) push
   * config. When present + enabled with all four secrets, the batch "Upload
   * All" flow can push each produced .acd to a SharePoint document library.
   * Absent/disabled → the whole SharePoint path is a no-op and the batch
   * upload behaves exactly as before. Mirrors the apiPassword secret pattern:
   * the clientSecret lives in config.json (or env override) and is never
   * logged or echoed back in an error.
   */
  sharepoint?: SharePointConfig;

  /**
   * Optional SNMP settings for the on-demand Ring Commissioning check. Absent
   * or enabled:false → the feature reads no switches and shows an explanatory
   * empty state; it never runs in the background and cannot affect core tool
   * behaviour. Community/creds live here alongside the other secrets.
   */
  snmp?: SnmpConfig;
}

/**
 * SNMP settings for ring-commissioning switch reads. All optional beyond the
 * enable flag; when disabled the ring-commissioning feature self-disables.
 */
export interface SnmpConfig {
  enabled: boolean;
  version: 'v2c' | 'v3';
  community?: string;
  port?: number;
  timeoutMs?: number;
  retries?: number;
}

/**
 * SharePoint app-only (Entra / Azure AD client-credentials) configuration.
 * All fields optional so a partial/absent block is safe; `isSharePointConfigured()`
 * gates real use on the four required secrets being present.
 */
export interface SharePointConfig {
  /** Master switch. Treated as enabled unless explicitly false. */
  enabled?: boolean;
  /** Entra tenant ID (GUID or domain). */
  tenantId?: string;
  /** App registration (client) ID. */
  clientId?: string;
  /** App client secret. Never logged or returned in errors. */
  clientSecret?: string;
  /** Full site URL, e.g. "https://contoso.sharepoint.com/sites/Commissioning". */
  siteUrl?: string;
  /** Optional folder path inside the default document library (no leading slash). */
  folderPath?: string;
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

  /**
   * Runtime-only (never persisted): true when config.json explicitly contained
   * an `mcms` array — i.e. this is a central / multi-MCM deployment whose
   * connections are owned by the MCM registry. False/undefined means the
   * `mcms` entry was synthesized from the legacy single-PLC fields (a field
   * tablet). Boot auto-connect uses this to decide whether to drive the
   * registry (central) or the legacy singleton (tablet) — they must never both
   * open a connection, or a stale top-level `ip` flaps against the wrong PLC.
   */
  mcmsExplicit?: boolean;
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
  lastConnectedSubsystemId?: string;
  lastConnectedAt?: string;
  plcProfiles?: PlcProfile[];
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
 *
 * CLOUD_URL_OVERRIDE: a deployment-time env override (NOT operator-facing, not
 * in config.json). Exists for the battle-test environment, which points the
 * tool at a throwaway cloud-stage so sync is exercised against a real cloud
 * WITHOUT ever touching production. Field installs never set it, so the
 * embedded production URL stands. The battle stack ALSO runs the tool on an
 * internet-less internal docker network, so even a missing override cannot
 * leak a test write to prod.
 */
// `typeof process` guard: this module is imported by CLIENT components (e.g.
// the PLC config dialog), and the browser has no `process` global — an
// unguarded `process.env` here is a ReferenceError that white-screens any page
// importing it (the /commissioning/:id view). The override is server-only
// anyway; in the browser the embedded production URL stands.
export const EMBEDDED_REMOTE_URL =
  (typeof process !== 'undefined' && process.env && process.env.CLOUD_URL_OVERRIDE) ||
  'https://commissioning.autstand.com';

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
 * One configured MCM entry in the central-tool multi-controller config.
 * A single server instance manages an array of these and serves each one
 * at /api/mcm/:subsystemId/...
 */
export interface McmConnection {
  /** Subsystem ID in the cloud — also the route key (`/api/mcm/:subsystemId`). */
  subsystemId: string;
  /** Human-readable name shown in the UI (e.g., "MCM03"). */
  name: string;
  /** PLC IP address. */
  ip: string;
  /** PLC Ethernet/IP routing path (e.g., "1,0"). */
  path: string;
  /** When false, the registry skips this MCM on bulk operations. */
  enabled?: boolean;
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
