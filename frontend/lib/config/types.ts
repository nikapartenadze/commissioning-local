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
