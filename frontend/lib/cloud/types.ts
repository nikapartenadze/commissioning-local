/**
 * Cloud Sync Types
 *
 * Type definitions for cloud API requests/responses and configuration.
 * These mirror the DTOs used in the C# backend.
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
}

export interface IoUpdateDto {
  id: number
  result?: string | null
  timestamp?: string | null
  comments?: string | null
  testedBy?: string | null
  state?: string | null
  version: number
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
}

export interface CloudPullResponse {
  success: boolean
  message?: string
  iosCount?: number
  error?: string
}

export interface CloudSyncStatusResponse {
  connected: boolean
  pendingSyncCount: number
  lastSyncAttempt?: string
  lastSuccessfulSync?: string
  error?: string
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
