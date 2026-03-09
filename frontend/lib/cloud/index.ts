/**
 * Cloud Sync Module
 *
 * Exports all cloud sync functionality for easy imports.
 *
 * Usage:
 *   import { CloudSyncService, getCloudSyncService } from '@/lib/cloud'
 *   import type { Io, IoUpdateDto, CloudSyncConfig } from '@/lib/cloud'
 */

// Service
export {
  CloudSyncService,
  getCloudSyncService,
  resetCloudSyncService,
} from './cloud-sync-service'

// Types
export type {
  // Configuration
  CloudSyncConfig,
  // IO Types
  Io,
  IoUpdateDto,
  IoSyncBatchDto,
  // Sync Request/Response
  SyncRequestDto,
  SyncResponseDto,
  CloudPullRequest,
  CloudPullResponse,
  CloudSyncStatusResponse,
  // Test History
  TestHistoryDto,
  TestHistorySyncBatchDto,
  // Pending Sync
  PendingSync,
  PendingSyncCreateInput,
  // Connection State
  ConnectionState,
  CloudConnectionStatus,
  // Results
  SyncResult,
  BatchSyncResult,
} from './types'

export { DEFAULT_CLOUD_CONFIG } from './types'
