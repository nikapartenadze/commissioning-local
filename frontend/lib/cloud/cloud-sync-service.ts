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
import { isNetworkLevelFailure } from '@/lib/cloud/sync-failure-classification'
import {
  listDeviceBlockerSyncs,
  deleteDeviceBlockerSync,
  recordDeviceBlockerSyncFailure,
  recordDeviceBlockerSyncTransientFailure,
} from '@/lib/db/repositories/device-blocker-sync-repository'
import {
  listVfdAddressedSyncs,
  deleteVfdAddressedSync,
  recordVfdAddressedSyncFailure,
  recordVfdAddressedSyncTransientFailure,
} from '@/lib/db/repositories/vfd-addressed-sync-repository'

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
  /**
   * True when the failure is network-level / environmental (offline, fetch
   * threw, 401 auth misconfig, 5xx) — the cloud never gave a verdict on the
   * payload. Caller must NOT count it toward the PendingSync retry cap;
   * burning the cap on network failures is what emptied the queue and
   * enabled the 2026-06-04 TPA8/MCM08 pull-wipe data loss.
   */
  network?: boolean
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
      return { ok: false, network: true, reason: 'offline' }
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
      return { ok: false, network: true, reason: 'offline' }
    }

    // Try HTTP sync
    try {
      const { remoteUrl } = await this.getCloudConfig()
      if (!remoteUrl) {
        log.warn('Cloud URL not configured')
        return { ok: false, network: true, reason: 'no remote URL' }
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
        // Config problem on the tool, not a cloud verdict on the row — must
        // not burn the retry cap, or a wrong API password deletes the queue.
        return { ok: false, network: true, reason: 'HTTP 401 auth failed' }
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
      // 4xx (other than 401/429) means the request was malformed — retrying
      // won't help. 401 (auth), 429 (rate limit) and 5xx (cloud/proxy down)
      // are transient and must NOT burn the retry cap: the row is fine, the
      // infrastructure is not. 429 specifically is bug B1 from the MCM11
      // incident — it was being deleted on first throttle (silent loss).
      // `permanent` MUST exclude 429 because the caller checks permanent
      // BEFORE network and deletes the row on permanent=true.
      const network = isNetworkLevelFailure({ httpStatus: response.status })
      const permanent = response.status >= 400 && response.status < 500 && !network
      return { ok: false, permanent, network, reason: `HTTP ${response.status}` }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.debug(`HTTP sync failed for IO ${update.id}: ${errorMessage}`)
      this.setConnectionState('error', 'Sync failed')
      // fetch threw — DNS / connect timeout / aborted. The payload never
      // reached the cloud app, so this must not count toward the retry cap.
      return { ok: false, network: true, reason: errorMessage }
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
    // Convert batch to DTOs. failureMode / hasDependencies live only on the
    // SQLite PendingSyncs row, not on this in-memory mirror; drainPendingSyncsForIo
    // is the authoritative drain path and it includes them via
    // mapPendingSyncToIoUpdate. This in-memory queue is only used as a
    // best-effort fallback when the DB-backed queue isn't available.
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

  // ===========================================================================
  // Device-level Blocker Sync (VFD bump-test failures)
  // ===========================================================================

  /**
   * Drain the DeviceBlockerPendingSyncs queue oldest-first, POSTing each row to
   * the cloud's /api/sync/device-blocker endpoint.
   *
   * Same retry-cap philosophy as the IO / L2 push (see auto-sync.ts and
   * sync-failure-classification.ts): a 2xx with a useful body deletes the row;
   * a cloud verdict (non-401 4xx, or 2xx with ok:false) burns a retry strike;
   * a network-level failure (fetch threw, no remote URL, 401, 5xx) keeps the
   * row alive WITHOUT a strike and stops the batch — every later row would
   * fail the same way and each attempt costs a timeout. The downstream
   * RETRY_CAP drop in auto-sync only ever fires on genuine cloud rejections.
   *
   * An unresolvable device on the cloud side returns 200 { ok:true,
   * deviceId:null } per the contract, so it is treated as success and removed
   * (it must NOT poison the queue).
   */
  async pushDeviceBlockerSyncs(): Promise<number> {
    const rows = listDeviceBlockerSyncs(50)
    if (rows.length === 0) return 0

    const { remoteUrl } = await this.getCloudConfig()
    if (!remoteUrl) {
      // No remote configured — network-level, no strikes. Leave the rows.
      log.debug('Device blocker push skipped — no remote URL configured')
      return 0
    }

    log.info(`Pushing ${rows.length} device blocker sync row(s) to cloud...`)

    let synced = 0
    for (const row of rows) {
      try {
        const headers = new Headers({ 'Content-Type': 'application/json' })
        await this.addApiKeyHeader(headers)

        // Body = the queue row, per the Task 5 cloud-endpoint contract.
        const body = {
          subsystemId: row.subsystemId,
          deviceName: row.deviceName,
          op: row.op,
          blockerResponsibleParty: row.blockerResponsibleParty ?? undefined,
          blockerDescription: row.blockerDescription ?? undefined,
          expectedParty: row.expectedParty ?? undefined,
          expectedDescription: row.expectedDescription ?? undefined,
          updatedBy: row.updatedBy ?? undefined,
          timestamp: row.timestamp ?? new Date().toISOString(),
        }

        const response = await this.fetchWithTimeout(
          `${remoteUrl}/api/sync/device-blocker`,
          { method: 'POST', headers, body: JSON.stringify(body) },
          15000,
        )

        if (response.status === 401) {
          // Auth/config problem on the tool, not a verdict on the row — must
          // not burn the retry cap (TPA8/MCM08 2026-06-04 lesson). Stop here.
          log.error('Device blocker push: HTTP 401 auth failed — deferring queue, no strikes burned')
          recordDeviceBlockerSyncTransientFailure(row.id, 'HTTP 401 auth failed')
          break
        }

        if (response.ok) {
          // The cloud always 200s even for an unresolvable device
          // (deviceId:null) so it never poisons the queue — treat any 2xx
          // with ok!==false as done.
          let data: { ok?: boolean; deviceId?: number | null; cleared?: boolean; reason?: string } | null = null
          try {
            data = await response.json()
          } catch {
            data = null
          }

          if (data && data.ok === false) {
            // Explicit cloud rejection — burns a strike (retry cap will drop it).
            log.warn(
              `[CloudSync] Device blocker row ${row.id} rejected by cloud: ${data.reason ?? 'unknown'} ` +
              `(device=${row.deviceName}, op=${row.op})`,
            )
            recordDeviceBlockerSyncFailure(row.id, `cloud-rejected: ${data.reason ?? 'unknown'}`)
            continue
          }

          deleteDeviceBlockerSync(row.id)
          synced++
          if (data?.deviceId == null) {
            log.warn(
              `[CloudSync] Device blocker row ${row.id} accepted but device unresolved on cloud ` +
              `(device=${row.deviceName}, subsystem=${row.subsystemId}, reason=${data?.reason ?? 'device-not-found'}). ` +
              `Row removed — Devices.Blocker* not written. Verify the device name matches a Devices row.`,
            )
          }
          this.setConnectionState('connected')
          continue
        }

        // Non-2xx, non-401.
        if (isNetworkLevelFailure({ httpStatus: response.status })) {
          // 5xx — cloud/proxy down. Keep the row, no strike, stop the batch.
          log.warn(`Device blocker push: HTTP ${response.status} (network-level) — deferring queue, no strikes burned`)
          recordDeviceBlockerSyncTransientFailure(row.id, `HTTP ${response.status} (network-level)`)
          break
        }

        // 4xx (other than 401): malformed/validation — retrying won't help.
        // Burn a strike so the retry cap eventually drops it.
        log.warn(`[CloudSync] Device blocker row ${row.id} got HTTP ${response.status} — counting a strike`)
        recordDeviceBlockerSyncFailure(row.id, `HTTP ${response.status}`)
      } catch (error) {
        // fetch threw (DNS / connect timeout / aborted) — never reached the
        // cloud, so no strike. Stop the batch.
        const msg = error instanceof Error ? error.message : String(error)
        log.debug(`Device blocker push failed for row ${row.id}: ${msg} — deferring queue, no strikes burned`)
        recordDeviceBlockerSyncTransientFailure(row.id, msg)
        this.setConnectionState('error', 'Device blocker sync failed')
        break
      }
    }

    if (synced > 0) {
      log.info(`Pushed ${synced} device blocker sync row(s) to cloud`)
    }
    return synced
  }

  // ===========================================================================
  // Belt-tracking ADDRESSED Sync (mechanic handoff flag)
  // ===========================================================================

  /**
   * Drain the VfdAddressedPendingSyncs queue oldest-first, POSTing each row to
   * the cloud's /api/sync/vfd-addressed endpoint, which lands it on
   * VfdCommissioningBlocker.addressed_* for the resolved (subsystem, device).
   *
   * Same retry-cap philosophy as pushDeviceBlockerSyncs: a 2xx with ok!==false
   * deletes the row; a cloud verdict (ok:false, or non-401 4xx) burns a strike;
   * a network-level failure (fetch threw, no remote URL, 401, 5xx) keeps the
   * row alive WITHOUT a strike and stops the batch.
   *
   * The cloud rejects (409) addressing a non-blocked belt; that is a genuine
   * verdict (a strike), since retrying the same payload will keep failing until
   * the row is eventually dropped by the retry cap — by then the local block has
   * almost certainly cleared (the wizard re-ran), so the ADDRESSED annotation is
   * moot anyway.
   */
  async pushVfdAddressedSyncs(): Promise<number> {
    const rows = listVfdAddressedSyncs(50)
    if (rows.length === 0) return 0

    const { remoteUrl } = await this.getCloudConfig()
    if (!remoteUrl) {
      log.debug('VFD addressed push skipped — no remote URL configured')
      return 0
    }

    log.info(`Pushing ${rows.length} VFD addressed sync row(s) to cloud...`)

    let synced = 0
    for (const row of rows) {
      try {
        const headers = new Headers({ 'Content-Type': 'application/json' })
        await this.addApiKeyHeader(headers)

        const body = {
          subsystemId: row.subsystemId,
          deviceName: row.deviceName,
          addressed: row.addressed,
          updatedBy: row.updatedBy ?? undefined,
          timestamp: row.timestamp ?? new Date().toISOString(),
        }

        const response = await this.fetchWithTimeout(
          `${remoteUrl}/api/sync/vfd-addressed`,
          { method: 'POST', headers, body: JSON.stringify(body) },
          15000,
        )

        if (response.status === 401) {
          log.error('VFD addressed push: HTTP 401 auth failed — deferring queue, no strikes burned')
          recordVfdAddressedSyncTransientFailure(row.id, 'HTTP 401 auth failed')
          break
        }

        if (response.ok) {
          let data: { ok?: boolean; reason?: string } | null = null
          try {
            data = await response.json()
          } catch {
            data = null
          }

          if (data && data.ok === false) {
            log.warn(
              `[CloudSync] VFD addressed row ${row.id} rejected by cloud: ${data.reason ?? 'unknown'} ` +
              `(device=${row.deviceName}, addressed=${row.addressed})`,
            )
            recordVfdAddressedSyncFailure(row.id, `cloud-rejected: ${data.reason ?? 'unknown'}`)
            continue
          }

          deleteVfdAddressedSync(row.id)
          synced++
          this.setConnectionState('connected')
          continue
        }

        if (isNetworkLevelFailure({ httpStatus: response.status })) {
          log.warn(`VFD addressed push: HTTP ${response.status} (network-level) — deferring queue, no strikes burned`)
          recordVfdAddressedSyncTransientFailure(row.id, `HTTP ${response.status} (network-level)`)
          break
        }

        // 4xx (other than 401), incl. 409 not-blocked: cloud verdict — strike it.
        log.warn(`[CloudSync] VFD addressed row ${row.id} got HTTP ${response.status} — counting a strike`)
        recordVfdAddressedSyncFailure(row.id, `HTTP ${response.status}`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        log.debug(`VFD addressed push failed for row ${row.id}: ${msg} — deferring queue, no strikes burned`)
        recordVfdAddressedSyncTransientFailure(row.id, msg)
        this.setConnectionState('error', 'VFD addressed sync failed')
        break
      }
    }

    if (synced > 0) {
      log.info(`Pushed ${synced} VFD addressed sync row(s) to cloud`)
    }
    return synced
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

// =============================================================================
// Device-level Blocker Push Trigger
// =============================================================================

/**
 * Debounced instant push of the DeviceBlockerPendingSyncs queue. Fired by the
 * local /api/vfd-commissioning/bump-blocker route right after it enqueues a
 * row, so a blocker set/clear reaches the cloud in ~1 s instead of waiting for
 * the 10 s background cycle. Debounced so a burst of rapid edits collapses
 * into a single drain. Best-effort — failures are swallowed; the background
 * loop (pushDeviceBlockerSyncs in the AutoSync tick) retries anything left.
 */
let deviceBlockerPushTimer: NodeJS.Timeout | null = null

export function triggerDeviceBlockerPush(debounceMs = 500): void {
  if (deviceBlockerPushTimer) clearTimeout(deviceBlockerPushTimer)
  deviceBlockerPushTimer = setTimeout(() => {
    deviceBlockerPushTimer = null
    void getCloudSyncService()
      .pushDeviceBlockerSyncs()
      .catch(err =>
        log.debug(`triggerDeviceBlockerPush drain failed: ${err instanceof Error ? err.message : String(err)}`),
      )
  }, debounceMs)
  // Don't keep the event loop alive for a best-effort push.
  if (typeof deviceBlockerPushTimer.unref === 'function') deviceBlockerPushTimer.unref()
}

// =============================================================================
// Belt-tracking ADDRESSED Push Trigger
// =============================================================================

/**
 * Debounced instant push of the VfdAddressedPendingSyncs queue. Fired by the
 * local /api/belt-tracking/addressed route right after it records + enqueues a
 * toggle, so it reaches the cloud in ~1 s. Best-effort — failures are swallowed;
 * the background loop (pushVfdAddressedSyncs in the AutoSync tick) retries the
 * rest. Mirrors triggerDeviceBlockerPush.
 */
let vfdAddressedPushTimer: NodeJS.Timeout | null = null

export function triggerVfdAddressedPush(debounceMs = 500): void {
  if (vfdAddressedPushTimer) clearTimeout(vfdAddressedPushTimer)
  vfdAddressedPushTimer = setTimeout(() => {
    vfdAddressedPushTimer = null
    void getCloudSyncService()
      .pushVfdAddressedSyncs()
      .catch(err =>
        log.debug(`triggerVfdAddressedPush drain failed: ${err instanceof Error ? err.message : String(err)}`),
      )
  }, debounceMs)
  if (typeof vfdAddressedPushTimer.unref === 'function') vfdAddressedPushTimer.unref()
}
