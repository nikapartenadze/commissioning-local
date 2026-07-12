/**
 * Cloud Sync Types
 *
 * Type definitions for cloud API requests/responses and configuration.
 */

// =============================================================================
// Configuration
// =============================================================================

export interface CloudSyncConfig {
  remoteUrl: string
  apiPassword: string
  subsystemId: number
  batchSize: number
  batchDelayMs: number
  connectionTimeoutMs: number
  retryDelayMs: number
  maxRetries: number
}

export const DEFAULT_CLOUD_CONFIG: CloudSyncConfig = {
  remoteUrl: '',
  apiPassword: '',
  subsystemId: 0,
  batchSize: 50,
  batchDelayMs: 500,
  connectionTimeoutMs: 10000,
  retryDelayMs: 30000,
  maxRetries: 3,
}

// =============================================================================
// IO Types
// =============================================================================

export interface Io {
  id: number
  subsystemId: number
  name: string
  description?: string | null
  state?: string | null
  result?: string | null
  timestamp?: string | null
  comments?: string | null
  order?: number | null
  version: bigint | number
  tagType?: string | null
  cloudSyncedAt?: Date | null
  networkDeviceName?: string | null
  installationStatus?: string | null    // 'complete' | 'in-progress' | 'not-started' | null
  installationPercent?: number | null   // 0.0 - 1.0
  deviceName?: string | null
  poweredUp?: boolean | null
}

export interface IoUpdateDto {
  id: number
  result?: string | null
  timestamp?: string | null
  comments?: string | null
  testedBy?: string | null
  state?: string | null
  version: number
  /**
   * Failure reason chosen in the fail dialog (e.g. '3rd Party', 'Mech',
   * 'No response'). Denormalised onto the cloud `ios` row so the sidebar
   * quick filters can match without joining test history. Null on
   * Pass / Cleared / comment-only ops.
   */
  failureMode?: string | null
  /**
   * Blocker assignment — the two columns the installation-tracker owns on
   * the shared `Devices` row. Sent ONLY when the tester explicitly assigns
   * a blocker (Unpass flow). Cloud routes these to Devices for the IO's
   * resolved device; a regular Fail leaves Devices untouched.
   */
  blockerResponsibleParty?: string | null
  blockerDescription?: string | null
  /**
   * Discipline picked by the tester on a Fail (Electrical/Controls/Mechanical).
   * Cloud lands it on the `ios.trade` column, which feeds the punchlist's
   * Discipline column. Null on Pass / Cleared.
   */
  trade?: string | null
  /**
   * Per-IO Yes/No flag toggled in the new Dependencies column. Cloud
   * stores and displays read-only. Null = unset (treated as 'No').
   */
  hasDependencies?: boolean | null
  /**
   * Punchlist resolver fields (F4): sent ONLY on the 'Punchlist Updated'
   * metadata op so ordinary Pass/Fail pushes never clobber the cloud's
   * resolver state. Explicit null = clear.
   */
  punchlistStatus?: string | null
  clarificationNote?: string | null
  /**
   * Operator force-overwrite (opt-in). When true the cloud applies this update
   * even if its version ran ahead of the tablet's base — local becomes
   * authority. Used to push a "stuck" result the operator has confirmed is
   * correct. Absent/false = normal optimistic-version push.
   */
  force?: boolean
}

export interface IoSyncBatchDto {
  updates: IoUpdateDto[]
  testHistories?: TestHistoryDto[]
}

// =============================================================================
// Sync Request/Response Types
// =============================================================================

export interface SyncRequestDto {
  subsystemId: number
}

export interface SyncResponseDto {
  success: boolean
  message?: string
  ios?: Io[]
}

export interface CloudPullRequest {
  remoteUrl: string
  subsystemId: number
  apiPassword: string
  /** Acknowledge the result-loss guard and pull anyway (see CloudPullResponse.requiresForce). */
  force?: boolean
}

export interface CloudPullResponse {
  success: boolean
  message?: string
  iosCount?: number
  error?: string
  /**
   * Result-loss guard (2026-06-04 TPA8/MCM08 incident): set when the pull
   * was refused because local IOs have results that the cloud payload lacks.
   * Re-send the pull with body.force === true to proceed anyway.
   */
  requiresForce?: boolean
  /** Local results the pull would erase (cloud has no result for these IOs). */
  wouldLoseResults?: number
  /** Local comments the pull would erase (cloud has no comment for these IOs). */
  wouldLoseComments?: number
  /** Sample of at-risk IOs for display: id, name, local result. */
  atRiskSample?: Array<{ id: number; name: string; result: string }>
  /** Sample of at-risk comment IOs for display: id, name. */
  atRiskCommentSample?: Array<{ id: number; name: string }>
}

export interface CloudSyncStatusResponse {
  connected: boolean
  pendingSyncCount: number
  pendingIoSyncCount?: number
  pendingL2SyncCount?: number
  pendingChangeRequestCount?: number
  totalPendingCount?: number
  /** Rows the cloud REJECTED or that exhausted retries — left the active queue
   *  but are NOT on cloud. The "needs attention" surface (B3/B5). */
  attentionCount?: number
  /** True when the status read itself failed — the counts are not reliable and
   *  the UI must NOT render "all synced" (B8). */
  statusUnknown?: boolean
  failedIoSyncCount?: number
  failedL2SyncCount?: number
  oldestPendingIoSync?: string
  oldestPendingL2Sync?: string
  oldestPendingChangeRequest?: string
  pullBlocked?: boolean
  dirtyQueues?: string[]
  connectionState?: ConnectionState
  autoSyncRunning?: boolean
  lastSyncAttempt?: string
  lastSuccessfulSync?: string
  lastPushAt?: string
  lastPullAt?: string
  lastPushResult?: string
  lastPullResult?: string
  configPath?: string
  databasePath?: string
  backupsPath?: string
  error?: string
}

export interface AppUpdateStatusResponse {
  currentVersion: string
  manifestUrl?: string
  manifestConfigured: boolean
  updateAvailable: boolean
  latestVersion?: string
  installerUrl?: string
  publishedAt?: string
  notes?: string
  installState?: {
    status: 'idle' | 'checking' | 'downloading' | 'installing' | 'restarting' | 'success' | 'error'
    message?: string
    version?: string
    startedAt?: string
    completedAt?: string
    installerUrl?: string
  } | null
  supported: boolean
  error?: string
  /** Version lockout (F7): present so the client overlay can poll lock state
   *  over the allowlisted /api/update prefix even while locked. */
  versionLock?: {
    locked: boolean
    currentVersion: string
    minVersion: string | null
    lockMessage: string | null
    policySource: 'live' | 'persisted' | 'none'
  }
}

// =============================================================================
// Test History Types
// =============================================================================

export interface TestHistoryDto {
  ioId: number
  result?: string | null
  timestamp?: string | null
  comments?: string | null
  testedBy?: string | null
  state?: string | null
  failureMode?: string | null
  blockerDescription?: string | null
}

export interface TestHistorySyncBatchDto {
  subsystemId: number
  histories: TestHistoryDto[]
}

// =============================================================================
// Pending Sync Types (Offline Queue)
// =============================================================================

export interface PendingSync {
  id: number
  ioId: number
  inspectorName?: string | null
  testResult?: string | null
  comments?: string | null
  state?: string | null
  timestamp?: Date | null
  createdAt: Date
  retryCount: number
  lastError?: string | null
  version: number
}

export interface PendingSyncCreateInput {
  ioId: number
  inspectorName?: string | null
  testResult?: string | null
  comments?: string | null
  state?: string | null
  timestamp?: Date | null
  version: number
}

// =============================================================================
// Connection State
// =============================================================================

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface CloudConnectionStatus {
  state: ConnectionState
  lastConnectionAttempt?: Date
  lastSuccessfulConnection?: Date
  error?: string
}

// =============================================================================
// Sync Result Types
// =============================================================================

export interface SyncResult {
  success: boolean
  syncedCount: number
  failedCount: number
  errors?: string[]
}

export interface BatchSyncResult {
  totalProcessed: number
  successfulIds: number[]
  failedIds: number[]
  rejectedIds: number[]
  errors: Map<number, string>
}
