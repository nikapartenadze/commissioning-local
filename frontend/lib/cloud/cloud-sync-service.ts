/**
 * Cloud Sync Service
 *
 * TypeScript port of the C# ResilientCloudSyncService.
 * Handles:
 * - Fetching IOs from remote PostgreSQL server
 * - Syncing test results to cloud
 * - Offline queue management (PendingSyncs)
 * - Batch sync with configurable size and delay
 * - Retry logic with exponential backoff
 */

import {
  CloudSyncConfig,
  DEFAULT_CLOUD_CONFIG,
  Io,
  IoUpdateDto,
  IoSyncBatchDto,
  SyncResponseDto,
  TestHistoryDto,
  TestHistorySyncBatchDto,
  PendingSync,
  PendingSyncCreateInput,
  ConnectionState,
  CloudConnectionStatus,
  SyncResult,
  BatchSyncResult,
} from './types'
import { configService } from '@/lib/config'

/**
 * Outcome of attempting to push a single IO update to cloud.
 * Distinguishes transient failures (retry) from permanent rejections
 * (delete the PendingSync row; retrying would be a no-op and waste the
 * retry cap).
 */
export interface SyncIoResult {
  ok: boolean
  /** True when retrying with the same payload will fail the same way. Caller MUST delete the PendingSync row. */
  permanent?: boolean
  /** Human-readable reason for the failure / rejection. */
  reason?: string
}

// =============================================================================
// Logger
// =============================================================================

const log = {
  info: (message: string, ...args: unknown[]) => console.log(`[CloudSync] ${message}`, ...args),
  warn: (message: string, ...args: unknown[]) => console.warn(`[CloudSync] ${message}`, ...args),
  error: (message: string, ...args: unknown[]) => console.error(`[CloudSync] ${message}`, ...args),
  debug: (message: string, ...args: unknown[]) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[CloudSync] ${message}`, ...args)
    }
  },
}

// =============================================================================
// Cloud Sync Service Class
// =============================================================================

export class CloudSyncService {
  private localConfig: Pick<CloudSyncConfig, 'batchSize' | 'batchDelayMs' | 'connectionTimeoutMs' | 'retryDelayMs' | 'maxRetries'>
  private connectionStatus: CloudConnectionStatus = {
    state: 'disconnected',
  }
  private offlineQueue: Map<number, PendingSync> = new Map()
  private readonly MAX_OFFLINE_QUEUE = 5000
  private connectionStateListeners: Set<(status: CloudConnectionStatus) => void> = new Set()

  constructor(config: Partial<CloudSyncConfig> = {}) {
    this.localConfig = {
      batchSize: config.batchSize ?? DEFAULT_CLOUD_CONFIG.batchSize,
      batchDelayMs: config.batchDelayMs ?? DEFAULT_CLOUD_CONFIG.batchDelayMs,
      connectionTimeoutMs: config.connectionTimeoutMs ?? DEFAULT_CLOUD_CONFIG.connectionTimeoutMs,
      retryDelayMs: config.retryDelayMs ?? DEFAULT_CLOUD_CONFIG.retryDelayMs,
      maxRetries: config.maxRetries ?? DEFAULT_CLOUD_CONFIG.maxRetries,
    }
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Read cloud config (remoteUrl, apiPassword, subsystemId) fresh from configService.
   * Non-cloud config (batchSize, retryConfig) stays in memory.
   */
  private async getCloudConfig(): Promise<{ remoteUrl: string; apiPassword: string; subsystemId: number }> {
    const appConfig = await configService.getConfig()
    return {
      remoteUrl: appConfig.remoteUrl || '',
      apiPassword: appConfig.apiPassword || '',
      subsystemId: Number(appConfig.subsystemId) || 0,
    }
  }

  /**
   * Write-through to configService. Updates cloud settings in config.json.
   * Non-cloud settings (batchSize, etc.) are stored in memory only.
   */
  async updateConfig(config: Partial<CloudSyncConfig>): Promise<void> {
    log.info('updateConfig called with:', {
      remoteUrl: config.remoteUrl,
      subsystemId: config.subsystemId,
      apiPassword: config.apiPassword ? `set (${config.apiPassword.length} chars)` : 'NOT SET',
    })

    // Update non-cloud config in memory
    if (config.batchSize !== undefined) this.localConfig.batchSize = config.batchSize
    if (config.batchDelayMs !== undefined) this.localConfig.batchDelayMs = config.batchDelayMs
    if (config.connectionTimeoutMs !== undefined) this.localConfig.connectionTimeoutMs = config.connectionTimeoutMs
    if (config.retryDelayMs !== undefined) this.localConfig.retryDelayMs = config.retryDelayMs
    if (config.maxRetries !== undefined) this.localConfig.maxRetries = config.maxRetries

    // Write cloud config through to configService (persists to config.json)
    const cloudUpdates: Record<string, unknown> = {}
    if (config.remoteUrl !== undefined) cloudUpdates.remoteUrl = config.remoteUrl
    if (config.apiPassword !== undefined) cloudUpdates.apiPassword = config.apiPassword
    if (config.subsystemId !== undefined) cloudUpdates.subsystemId = String(config.subsystemId)

    if (Object.keys(cloudUpdates).length > 0) {
      await configService.saveConfig(cloudUpdates)
    }

    const fresh = await this.getCloudConfig()
    log.info('Configuration after update:', {
      remoteUrl: fresh.remoteUrl,
      subsystemId: fresh.subsystemId,
      apiPassword: fresh.apiPassword ? `set (${fresh.apiPassword.length} chars)` : 'NOT SET',
    })
  }

  /**
   * Get a snapshot of the full config (cloud fields from configService + local fields).
   * Async because cloud fields come from configService.
   */
  async getConfig(): Promise<CloudSyncConfig> {
    const cloud = await this.getCloudConfig()
    return {
      ...cloud,
      ...this.localConfig,
    }
  }

  // ===========================================================================
  // Connection State Management
  // ===========================================================================

  get isConnected(): boolean {
    return this.connectionStatus.state === 'connected'
  }

  get connectionState(): ConnectionState {
    return this.connectionStatus.state
  }

  onConnectionStateChange(listener: (status: CloudConnectionStatus) => void): () => void {
    this.connectionStateListeners.add(listener)
    return () => this.connectionStateListeners.delete(listener)
  }

  setConnectionState(state: ConnectionState, error?: string): void {
    const previousState = this.connectionStatus.state
    this.connectionStatus = {
      ...this.connectionStatus,
      state,
      error,
      lastConnectionAttempt: new Date(),
    }

    if (state === 'connected' && previousState !== 'connected') {
      this.connectionStatus.lastSuccessfulConnection = new Date()
    }

    this.connectionStateListeners.forEach(listener => listener(this.connectionStatus))
    log.debug(`Connection state changed: ${previousState} -> ${state}`)
  }

  // ===========================================================================
  // HTTP Helper Methods
  // ===========================================================================

  private async addApiKeyHeader(headers: Headers): Promise<void> {
    const { apiPassword } = await this.getCloudConfig()
    if (apiPassword) {
      headers.set('X-API-Key', apiPassword)  // Must match C# backend header name
    }
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs: number = this.localConfig.connectionTimeoutMs
  ): Promise<Response> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      })
      return response
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit = {},
    maxRetries: number = this.localConfig.maxRetries
  ): Promise<Response> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, options)

        if (response.ok) {
          return response
        }

        // Authentication error - don't retry
        if (response.status === 401) {
          log.error('Authentication failed - invalid API password')
          throw new Error('Authentication failed - check API password')
        }

        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error('Request timed out')
        } else {
          lastError = error instanceof Error ? error : new Error(String(error))
        }
      }

      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s, ...
        const delay = 1000 * Math.pow(2, attempt)
        log.debug(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`)
        await this.delay(delay)
      }
    }

    throw lastError || new Error('Request failed after all retries')
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // ===========================================================================
  // Cloud Availability Check
  // ===========================================================================

  async isCloudAvailable(): Promise<boolean> {
    const { remoteUrl } = await this.getCloudConfig()
    if (!remoteUrl) {
      return false
    }

    try {
      const headers = new Headers({ 'Content-Type': 'application/json' })
      await this.addApiKeyHeader(headers)

      const response = await this.fetchWithTimeout(
        `${remoteUrl}/api/sync/health`,
        { method: 'GET', headers },
        10000
      )

      if (response.ok) {
        log.info(`Cloud health check passed for ${remoteUrl}`)
        this.setConnectionState('connected')
        return true
      }

      this.setConnectionState('error', `Health check failed: ${response.status}`)
      return false
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.debug(`Cloud health check failed: ${errorMessage}`)
      this.setConnectionState('error', errorMessage)
      return false
    }
  }

  // ===========================================================================
  // Fetch IOs from Cloud
  // ===========================================================================

  async getSubsystemIos(subsystemId: number): Promise<Io[]> {
    const cloudConfig = await this.getCloudConfig()
    if (!cloudConfig.remoteUrl) {
      log.warn('Cloud URL not configured')
      return []
    }

    const url = `${cloudConfig.remoteUrl}/api/sync/subsystem/${subsystemId}`
    log.info(`Fetching IOs from: ${url}`)
    log.info(`API Password configured: ${cloudConfig.apiPassword ? 'yes (' + cloudConfig.apiPassword.length + ' chars)' : 'no'}`)

    try {
      const headers = new Headers({ 'Content-Type': 'application/json' })
      await this.addApiKeyHeader(headers)

      const response = await this.fetchWithTimeout(
        url,
        { method: 'GET', headers },
        90000 // Allow time for large subsystem queries
      )

      if (response.status === 401) {
        log.error('Authentication failed - invalid API password')
        throw new Error('Authentication failed - check API password')
      }

      if (!response.ok) {
        log.error(`Failed to get IOs from cloud: ${response.status}`)
        return []
      }

      const data = await response.json()

      // Debug: log raw response structure
      console.log('[CloudSync] Raw response keys:', Object.keys(data))
      console.log('[CloudSync] Response type:', typeof data)
      if (Array.isArray(data)) {
        console.log('[CloudSync] Response is array with length:', data.length)
      } else if (data.ios) {
        console.log('[CloudSync] data.ios length:', data.ios.length)
      } else if (data.Ios) {
        console.log('[CloudSync] data.Ios length:', data.Ios.length)
      }

      // Handle both possible response formats: { ios: [...] } or direct array
      const ioArray = Array.isArray(data) ? data : (data.ios || data.Ios || [])

      // Transform cloud IOs to match local format
      const ios: Io[] = ioArray.map((io: any) => ({
        id: io.id,
        subsystemId: io.subsystemId,
        name: io.name,
        description: io.description,
        state: io.state,
        result: io.result,
        timestamp: io.timestamp,
        comments: io.comments,
        order: io.order,
        version: io.version,
        tagType: io.tagType,
      }))

      log.info(`Retrieved ${ios.length} IOs from cloud for subsystem ${subsystemId}`)
      return ios
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error(`Error getting IOs from cloud: ${errorMessage}`)
      throw error
    }
  }

  // ===========================================================================
  // Sync Single IO Update
  // ===========================================================================

  async syncIoUpdate(update: IoUpdateDto): Promise<SyncIoResult> {
    // If we know we're offline, queue immediately
    if (
      this.connectionStatus.state !== 'connected' &&
      this.connectionStatus.lastConnectionAttempt &&
      Date.now() - this.connectionStatus.lastConnectionAttempt.getTime() < this.localConfig.retryDelayMs
    ) {
      await this.addToOfflineQueue(update)
      log.debug(`Queued IO ${update.id} for offline sync (connection unavailable)`)
      return { ok: false, reason: 'offline' }
    }

    // Try real-time sync
    const result = await this.tryRealtimeSync(update)

    if (!result.ok && !result.permanent) {
      await this.addToOfflineQueue(update)
      log.info(`Added IO ${update.id} to offline queue for later sync`)
    }

    return result
  }

  // ===========================================================================
  // Sync Multiple IO Updates
  // ===========================================================================

  async syncIoUpdates(updates: IoUpdateDto[]): Promise<boolean> {
    if (updates.length === 0) return true

    // For small batches, try batch sync first
    if (updates.length > 1 && updates.length <= this.localConfig.batchSize) {
      if (await this.tryRealtimeBatchSync(updates)) {
        log.info(`Successfully batch synced ${updates.length} updates`)
        return true
      }
      log.warn('Batch sync failed, falling back to individual processing')
    }

    // Fall back to individual processing
    let successCount = 0
    const failedUpdates: IoUpdateDto[] = []

    for (const update of updates) {
      const r = await this.tryRealtimeSync(update)
      if (r.ok) {
        successCount++
      } else if (!r.permanent) {
        // Only requeue transient failures. Permanent rejections (e.g. null
        // result, validation error) would re-fail forever and burn the retry
        // cap; the caller already saw the warn log inside tryRealtimeSync.
        failedUpdates.push(update)
      }
    }

    // Add failed updates to offline queue
    if (failedUpdates.length > 0) {
      for (const update of failedUpdates) {
        await this.addToOfflineQueue(update)
      }
      log.info(`Added ${failedUpdates.length} failed updates to offline queue`)
    }

    return successCount === updates.length
  }

  // ===========================================================================
  // Sync Test Histories
  // ===========================================================================

  async syncTestHistories(subsystemId: number, histories: TestHistoryDto[]): Promise<boolean> {
    if (histories.length === 0) return true

    const cloudConfig = await this.getCloudConfig()
    if (!cloudConfig.remoteUrl) {
      log.warn('Cloud URL not configured - cannot sync TestHistories')
      return false
    }

    try {
      const headers = new Headers({ 'Content-Type': 'application/json' })
      await this.addApiKeyHeader(headers)

      const batch: TestHistorySyncBatchDto = {
        subsystemId,
        histories,
      }

      const response = await this.fetchWithTimeout(
        `${cloudConfig.remoteUrl}/api/sync/test-histories`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(batch),
        },
        30000
      )

      if (response.ok) {
        log.info(`Successfully synced ${histories.length} TestHistory records to cloud`)
        return true
      }

      if (response.status === 404) {
        log.debug('Cloud server does not support TestHistory sync endpoint yet (404)')
        return false
      }

      log.warn(`Failed to sync TestHistories to cloud: ${response.status}`)
      return false
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.debug(`TestHistory sync failed: ${errorMessage}`)
      return false
    }
  }

  // ===========================================================================
  // Real-time Sync Methods
  // ===========================================================================

  private async tryRealtimeSync(update: IoUpdateDto): Promise<SyncIoResult> {
    log.debug(`Attempting real-time sync for IO ${update.id}`)

    // Quick check if we're offline
    if (
      this.connectionStatus.state !== 'connected' &&
      this.connectionStatus.lastConnectionAttempt &&
      Date.now() - this.connectionStatus.lastConnectionAttempt.getTime() < this.localConfig.retryDelayMs
    ) {
      log.debug(`Skipping sync for IO ${update.id} - offline`)
      return { ok: false, reason: 'offline' }
    }

    // Try HTTP sync
    try {
      const { remoteUrl } = await this.getCloudConfig()
      if (!remoteUrl) {
        log.warn('Cloud URL not configured')
        return { ok: false, reason: 'no remote URL' }
      }

      const headers = new Headers({ 'Content-Type': 'application/json' })
      await this.addApiKeyHeader(headers)

      const batch: IoSyncBatchDto = { updates: [update] }

      const response = await this.fetchWithTimeout(
        `${remoteUrl}/api/sync/update`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(batch),
        },
        15000
      )

      if (response.status === 401) {
        log.error('Authentication failed for IO sync')
        return { ok: false, reason: 'HTTP 401 auth failed' }
      }

      if (response.ok) {
        type SyncResp = {
          updatedCount?: number
          rejected?: { id: number; reason: string; permanent?: boolean }[]
        }
        let responseData: SyncResp | null = null
        try {
          responseData = await response.json() as SyncResp
        } catch {
          responseData = null
        }

        // Cloud now surfaces rejections explicitly (added 2026-05-21 after the
        // silent-drop incident). If our IO was rejected with permanent=true,
        // the next retry would fail the same way — surface permanent=true to
        // the caller so the PendingSync row is deleted immediately and we
        // don't burn the retry cap for nothing.
        const rejection = responseData?.rejected?.find(r => r.id === update.id)
        if (rejection?.permanent) {
          log.error(
            `[CloudSync] Cloud PERMANENTLY rejected IO ${update.id}: ${rejection.reason}. ` +
            `Payload was: result=${JSON.stringify(update.result)}, version=${update.version}, ` +
            `state=${JSON.stringify(update.state)}, testedBy=${JSON.stringify(update.testedBy)}. ` +
            `Local SQLite still has this IO's state — re-pass/fail/clear in the grid if the value is wrong on cloud.`
          )
          return { ok: false, permanent: true, reason: `cloud-rejected: ${rejection.reason}` }
        }

        if (responseData?.updatedCount !== undefined && responseData.updatedCount < 1) {
          // Log the full payload so logs.zip captures enough to recover from.
          log.warn(
            `[CloudSync] Cloud accepted HTTP request for IO ${update.id} but updatedCount=0. ` +
            `Payload: result=${JSON.stringify(update.result)}, version=${update.version}, ` +
            `tester=${JSON.stringify(update.testedBy)}, state=${JSON.stringify(update.state)}, ` +
            `ts=${update.timestamp}. ` +
            `Most likely cause: version mismatch (cloud already moved past local).`
          )
          return { ok: false, reason: 'updatedCount=0 (version mismatch likely)' }
        }

        log.info(`Successfully synced IO ${update.id} via HTTP`)
        this.setConnectionState('connected')
        return { ok: true }
      }

      log.error(
        `[CloudSync] HTTP sync failed for IO ${update.id}: status=${response.status}. ` +
        `Payload: result=${JSON.stringify(update.result)}, version=${update.version}, ` +
        `tester=${JSON.stringify(update.testedBy)}, state=${JSON.stringify(update.state)}, ts=${update.timestamp}`,
      )
      this.setConnectionState('error', 'Sync failed')
      // 4xx (other than 401) means the request was malformed — retrying won't
      // help. 5xx is transient. Treat 4xx as permanent so the row is dropped.
      const permanent = response.status >= 400 && response.status < 500
      return { ok: false, permanent, reason: `HTTP ${response.status}` }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.debug(`HTTP sync failed for IO ${update.id}: ${errorMessage}`)
      this.setConnectionState('error', 'Sync failed')
      return { ok: false, reason: errorMessage }
    }
  }

  private async tryRealtimeBatchSync(updates: IoUpdateDto[]): Promise<boolean> {
    log.info(`Attempting batch sync for ${updates.length} updates`)

    // Quick check if we're offline
    if (
      this.connectionStatus.state !== 'connected' &&
      this.connectionStatus.lastConnectionAttempt &&
      Date.now() - this.connectionStatus.lastConnectionAttempt.getTime() < this.localConfig.retryDelayMs
    ) {
      log.debug('Skipping batch sync - offline')
      return false
    }

    try {
      const { remoteUrl } = await this.getCloudConfig()
      if (!remoteUrl) {
        log.warn('Cloud URL not configured for HTTP batch fallback')
        return false
      }

      const headers = new Headers({ 'Content-Type': 'application/json' })
      await this.addApiKeyHeader(headers)

      const batch: IoSyncBatchDto = { updates }

      const response = await this.fetchWithTimeout(
        `${remoteUrl}/api/sync/update`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(batch),
        },
        20000 // Longer timeout for batch
      )

      if (response.status === 401) {
        log.error('Authentication failed for batch sync')
        return false
      }

      if (response.ok) {
        let responseData: { updatedCount?: number } | null = null
        try {
          responseData = await response.json()
        } catch {
          responseData = null
        }

        if (
          responseData?.updatedCount !== undefined &&
          responseData.updatedCount < updates.length
        ) {
          log.warn(`Cloud accepted batch HTTP request but only updated ${responseData.updatedCount}/${updates.length} IOs`)
          return false
        }

        log.info(`Successfully batch synced ${updates.length} IOs via HTTP`)
        this.setConnectionState('connected')
        return true
      }

      log.error(`HTTP batch sync failed: ${response.status}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error(`HTTP batch sync failed: ${errorMessage}`)
    }

    this.setConnectionState('error', 'Batch sync failed')
    return false
  }

  // ===========================================================================
  // Offline Queue Management
  // ===========================================================================

  private async addToOfflineQueue(update: IoUpdateDto): Promise<void> {
    const pendingSync: PendingSync = {
      id: Date.now(), // Temporary ID for in-memory queue
      ioId: update.id,
      inspectorName: update.testedBy,
      testResult: update.result,
      comments: update.comments,
      state: update.state,
      version: update.version,
      timestamp: update.timestamp ? new Date(update.timestamp) : undefined,
      createdAt: new Date(),
      retryCount: 0,
    }

    // Evict oldest if queue is full (items are also persisted in SQLite PendingSyncs)
    if (this.offlineQueue.size >= this.MAX_OFFLINE_QUEUE) {
      const oldest = this.offlineQueue.keys().next().value
      if (oldest !== undefined) this.offlineQueue.delete(oldest)
    }
    this.offlineQueue.set(update.id, pendingSync)
    log.info(`Added IO ${update.id} to offline queue with version ${update.version}`)
  }

  /**
   * Get all pending syncs from the offline queue
   */
  getPendingSyncs(): PendingSync[] {
    return Array.from(this.offlineQueue.values()).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    )
  }

  /**
   * Get the count of pending syncs
   */
  getPendingSyncCount(): number {
    return this.offlineQueue.size
  }

  /**
   * Clear a specific pending sync by ID
   */
  removePendingSync(id: number): void {
    this.offlineQueue.delete(id)
  }

  /**
   * Clear multiple pending syncs by ID
   */
  removePendingSyncs(ids: number[]): void {
    for (const id of ids) {
      this.offlineQueue.delete(id)
    }
  }

  /**
   * Clear all pending syncs
   */
  clearPendingSyncs(): void {
    this.offlineQueue.clear()
  }

  // ===========================================================================
  // Process Pending Syncs
  // ===========================================================================

  /**
   * Sync pending updates from the offline queue
   */
  async syncPendingUpdates(): Promise<number> {
    const pendingSyncs = this.getPendingSyncs()

    if (pendingSyncs.length === 0) {
      return 0
    }

    log.info(`Found ${pendingSyncs.length} pending syncs in offline queue`)

    let totalSynced = 0
    const successfulIds: number[] = []

    // Process in batches
    for (let i = 0; i < pendingSyncs.length; i += this.localConfig.batchSize) {
      const batch = pendingSyncs.slice(i, i + this.localConfig.batchSize)
      log.info(
        `Processing batch of ${batch.length} pending syncs (batch ${Math.floor(i / this.localConfig.batchSize) + 1}/${Math.ceil(pendingSyncs.length / this.localConfig.batchSize)})`
      )

      const batchSuccessIds = await this.tryBatchSyncPending(batch)

      if (batchSuccessIds.length > 0) {
        successfulIds.push(...batchSuccessIds)
        totalSynced += batchSuccessIds.length
        log.info(`Successfully synced ${batchSuccessIds.length} items in batch`)
      }

      // Small delay between batches
      if (i + this.localConfig.batchSize < pendingSyncs.length) {
        await this.delay(this.localConfig.batchDelayMs)
      }
    }

    // Remove successfully synced items from queue
    if (successfulIds.length > 0) {
      this.removePendingSyncs(successfulIds)
      log.info(`Removed ${successfulIds.length} successfully synced items from queue`)
    }

    return totalSynced
  }

  private async tryBatchSyncPending(batch: PendingSync[]): Promise<number[]> {
    // Convert batch to DTOs
    const updates: IoUpdateDto[] = batch.map(pending => ({
      id: pending.ioId,
      testedBy: pending.inspectorName,
      result: pending.testResult,
      comments: pending.comments,
      state: pending.state,
      version: pending.version,
      timestamp: pending.timestamp?.toISOString(),
    }))

    // Try batch sync
    if (await this.tryRealtimeBatchSync(updates)) {
      return batch.map(p => p.ioId)
    }

    // Batch sync failed, fall back to individual sync
    log.warn(`Batch sync failed, falling back to individual sync for ${batch.length} items`)

    const successfulIds: number[] = []

    for (const pending of batch) {
      const update = updates.find(u => u.id === pending.ioId)
      if (!update) continue

      try {
        const r = await this.tryRealtimeSync(update)
        if (r.ok) {
          successfulIds.push(pending.ioId)
          log.debug(`Successfully synced pending IO ${pending.ioId} individually`)
        } else {
          pending.retryCount++
          pending.lastError = r.reason ?? 'Individual sync failed after batch failure'
          log.warn(`Failed to sync pending IO ${pending.ioId} individually (${r.reason ?? 'unknown'})`)
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error(`Exception syncing pending IO ${pending.ioId}: ${errorMessage}`)
        pending.retryCount++
        pending.lastError = errorMessage
      }

      // Small delay between individual syncs
      await this.delay(100)
    }

    return successfulIds
  }

  /**
   * Sync pending updates — cloud always accepts (local tool is the authority).
   * No version conflict rejection: every pending sync is pushed unconditionally.
   */
  async syncPendingUpdatesWithVersionControl(
    getLocalIo: (ioId: number) => Promise<Io | null>
  ): Promise<BatchSyncResult> {
    const pendingSyncs = this.getPendingSyncs()
    const result: BatchSyncResult = {
      totalProcessed: pendingSyncs.length,
      successfulIds: [],
      failedIds: [],
      rejectedIds: [],
      errors: new Map(),
    }

    if (pendingSyncs.length === 0) {
      return result
    }

    log.info(`Syncing ${pendingSyncs.length} pending updates (local-tool-is-leader, no version gating)`)

    for (const pending of pendingSyncs) {
      try {
        const update: IoUpdateDto = {
          id: pending.ioId,
          testedBy: pending.inspectorName,
          result: pending.testResult,
          comments: pending.comments,
          state: pending.state,
          version: pending.version,
          timestamp: pending.timestamp?.toISOString(),
        }

        const r = await this.tryRealtimeSync(update)
        if (r.ok) {
          result.successfulIds.push(pending.ioId)
          log.debug(`Successfully synced pending IO ${pending.ioId}`)
        } else {
          result.failedIds.push(pending.ioId)
          result.errors.set(pending.ioId, r.reason ?? 'Sync failed - will retry later')
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error(`Exception processing pending sync for IO ${pending.ioId}: ${errorMessage}`)
        result.failedIds.push(pending.ioId)
        result.errors.set(pending.ioId, errorMessage)
      }
    }

    // Remove successfully synced items
    if (result.successfulIds.length > 0) {
      this.removePendingSyncs(result.successfulIds)
      log.info(`Successfully synced and removed ${result.successfulIds.length} changes from queue`)
    }

    return result
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let cloudSyncServiceInstance: CloudSyncService | null = null

export function getCloudSyncService(config?: Partial<CloudSyncConfig>): CloudSyncService {
  if (!cloudSyncServiceInstance) {
    cloudSyncServiceInstance = new CloudSyncService(config)
  } else if (config) {
    // updateConfig is async (writes through to configService), but we fire-and-forget
    // for backward compatibility with callers that don't await
    cloudSyncServiceInstance.updateConfig(config)
  }
  return cloudSyncServiceInstance
}

export function resetCloudSyncService(): void {
  cloudSyncServiceInstance = null
}
