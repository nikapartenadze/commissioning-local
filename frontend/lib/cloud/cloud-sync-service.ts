/**
 * Cloud Sync Service
 *
 * Real-time push of a single IO/test-result update to the cloud, plus the
 * device-blocker queue drain. Handles:
 * - Fetching IOs from the remote server
 * - Syncing test results to cloud (one update at a time)
 *
 * NOTE: this service does NOT own an offline queue. Durability lives in the
 * SQLite PendingSyncs table, drained by AutoSync (lib/cloud/auto-sync.ts).
 * Do not reintroduce an in-memory queue here — there must be exactly one.
 */

import {
  CloudSyncConfig,
  DEFAULT_CLOUD_CONFIG,
  Io,
  IoUpdateDto,
  IoSyncBatchDto,
  SyncResponseDto,
  PendingSyncCreateInput,
  ConnectionState,
  CloudConnectionStatus,
  SyncResult,
} from './types'
import { configService } from '@/lib/config'
import { isNetworkLevelFailure } from '@/lib/cloud/sync-failure-classification'
import { SubsystemNetworkDeferral } from '@/lib/cloud/subsystem-network-deferral'
import {
  listDeviceBlockerSyncs,
  deleteDeviceBlockerSync,
  recordDeviceBlockerSyncFailure,
  recordDeviceBlockerSyncTransientFailure,
  parkDeviceBlockerSync,
} from '@/lib/db/repositories/device-blocker-sync-repository'
import { auditLog } from '@/lib/logging/recovery-log'

// Retry cap for device-blocker queue rows (F7, 2026-07-03 sync audit): same
// 10-strike park policy as every other queue. Before this, a permanently-
// rejected blocker re-POSTed every 10s FOREVER and never surfaced anywhere.
const DEVICE_BLOCKER_RETRY_CAP = 10

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

  // (removed) fetchWithRetry + delay helpers — dead code. Real-time syncs use
  // fetchWithTimeout directly and durability is owned by the SQLite
  // PendingSyncs queue + AutoSync drain, so this retry/backoff pair had no
  // caller. Deleted in the 2026-07 tech-debt cleanup.

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
    // If we know we're offline, short-circuit as a network-level failure so the
    // caller burns no retry-cap strike. Durability is owned by the SQLite
    // PendingSyncs queue + AutoSync drain — this service no longer keeps its own
    // in-memory offline queue (the C#-port artifact was dead; nothing drained it).
    if (
      this.connectionStatus.state !== 'connected' &&
      this.connectionStatus.lastConnectionAttempt &&
      Date.now() - this.connectionStatus.lastConnectionAttempt.getTime() < this.localConfig.retryDelayMs
    ) {
      log.debug(`Skipping sync for IO ${update.id} — offline (durability via SQLite PendingSyncs)`)
      return { ok: false, network: true, reason: 'offline' }
    }

    // Try real-time sync and report the outcome; the SQLite PendingSyncs row
    // (owned by AutoSync) is the durable retry queue.
    return this.tryRealtimeSync(update)
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

    // Per-subsystem network-failure deferral: this queue is global (oldest-first
    // across all MCMs). A batch-wide `break` on a network failure let ONE
    // misconfigured MCM (whose rows sort first) starve every other MCM's blocker
    // pushes every cycle — the same multi-MCM starvation fixed for the IO/e-stop
    // drains. Defer only the offending MCM (tolerance 1 = the old stop-on-first
    // behaviour, now scoped per MCM); a single-MCM box still stops after one
    // failed attempt, other MCMs keep draining.
    const deferral = new SubsystemNetworkDeferral(1)
    let synced = 0
    for (const row of rows) {
      if (deferral.isDeferred(row.subsystemId)) continue
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
          log.error('Device blocker push: HTTP 401 auth failed — deferring this MCM, no strikes burned')
          recordDeviceBlockerSyncTransientFailure(row.id, 'HTTP 401 auth failed')
          deferral.recordNetworkFailure(row.subsystemId)
          continue
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
            // Explicit cloud rejection — burns a strike; the cap PARKS the row.
            log.warn(
              `[CloudSync] Device blocker row ${row.id} rejected by cloud: ${data.reason ?? 'unknown'} ` +
              `(device=${row.deviceName}, op=${row.op})`,
            )
            this.strikeOrParkDeviceBlocker(row, `cloud-rejected: ${data.reason ?? 'unknown'}`)
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
          log.warn(`Device blocker push: HTTP ${response.status} (network-level) — deferring this MCM, no strikes burned`)
          recordDeviceBlockerSyncTransientFailure(row.id, `HTTP ${response.status} (network-level)`)
          deferral.recordNetworkFailure(row.subsystemId)
          continue
        }

        // 4xx (other than 401): malformed/validation — retrying won't help.
        // Burn a strike; at the cap the row is PARKED for attention.
        log.warn(`[CloudSync] Device blocker row ${row.id} got HTTP ${response.status} — counting a strike`)
        this.strikeOrParkDeviceBlocker(row, `HTTP ${response.status}`)
      } catch (error) {
        // fetch threw (DNS / connect timeout / aborted) — never reached the
        // cloud, so no strike. Stop the batch.
        const msg = error instanceof Error ? error.message : String(error)
        log.debug(`Device blocker push failed for row ${row.id}: ${msg} — deferring this MCM, no strikes burned`)
        recordDeviceBlockerSyncTransientFailure(row.id, msg)
        this.setConnectionState('error', 'Device blocker sync failed')
        deferral.recordNetworkFailure(row.subsystemId)
        continue
      }
    }

    if (synced > 0) {
      log.info(`Pushed ${synced} device blocker sync row(s) to cloud`)
    }
    return synced
  }

  /**
   * Burn a retry strike on a device-blocker queue row; at the cap, PARK it
   * (DeadLettered=1) instead of retrying forever — the row and its values
   * survive for operator attention, journaled to the recovery log. (F7)
   */
  private strikeOrParkDeviceBlocker(
    row: { id: number; subsystemId: number; deviceName: string; op: string; retryCount: number; updatedBy: string | null },
    error: string,
  ): void {
    const newCount = row.retryCount + 1
    if (newCount < DEVICE_BLOCKER_RETRY_CAP) {
      recordDeviceBlockerSyncFailure(row.id, error)
      return
    }
    parkDeviceBlockerSync(row.id, `${error} — parked after ${newCount} retries`)
    log.error(
      `[CloudSync] Device blocker row ${row.id} PARKED after ${newCount} retries ` +
      `(device=${row.deviceName}, op=${row.op}, subsystem=${row.subsystemId}): ${error}`,
    )
    auditLog({
      type: 'sync.push.park',
      subsystemId: row.subsystemId,
      user: row.updatedBy,
      reason: `device-blocker retry-cap (${DEVICE_BLOCKER_RETRY_CAP}) — parked for attention: ${error}`,
      detail: { kind: 'device-blocker', pendingId: row.id, deviceName: row.deviceName, op: row.op },
    })
  }

  // ===========================================================================
  // (removed) Belt-tracking ADDRESSED push — marking now happens on the cloud
  // only; the field tool PULLS the cloud-authoritative flag instead. See
  // lib/cloud/vfd-addressed-pull.ts.
  // ===========================================================================
}


// =============================================================================
// Singleton Instance
// =============================================================================

let cloudSyncServiceInstance: CloudSyncService | null = null

export function getCloudSyncService(config?: Partial<CloudSyncConfig>): CloudSyncService {
  if (!cloudSyncServiceInstance) {
    cloudSyncServiceInstance = new CloudSyncService(config)
  } else if (config) {
    // updateConfig is async (writes config.json through configService), but this
    // getter stays sync for backward compatibility with callers that don't await.
    // A rejected disk write must NOT become an unhandled rejection (which would
    // also silently leave on-disk config lagging memory) — track it with a
    // .catch that logs so the desync is at least visible in the logs.
    void cloudSyncServiceInstance.updateConfig(config).catch((err) => {
      log.error(
        `getCloudSyncService: background updateConfig failed — on-disk config may lag memory: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
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
