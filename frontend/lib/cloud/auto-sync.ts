/**
 * Automatic Bidirectional Sync Service
 *
 * Runs in the background on the server:
 * - Push: Drains PendingSync queue to cloud every 30s
 * - Pull: Checks for IO definition changes from cloud every 60s
 *
 * Preserves data ownership:
 * - Cloud owns IO definitions (name, description, order)
 * - Site owns test results (result, timestamp, comments, testedBy)
 */

import { prisma } from '@/lib/db'
import { configService } from '@/lib/config'
import { startCloudSse, stopCloudSse, getCloudSseClient } from '@/lib/cloud/cloud-sse-client'

export interface AutoSyncConfig {
  pushIntervalMs: number    // default 30000 (30s)
  pullIntervalMs: number    // default 60000 (60s)
  enabled: boolean          // default true
  maxRetries: number        // default 3
}

const DEFAULT_AUTO_SYNC_CONFIG: AutoSyncConfig = {
  pushIntervalMs: 30000,
  pullIntervalMs: 60000,
  enabled: true,
  maxRetries: 3,
}

export interface AutoSyncStatus {
  running: boolean
  config: AutoSyncConfig
  lastPushAt: string | null
  lastPullAt: string | null
  lastPushResult: string | null
  lastPullResult: string | null
  pendingCount: number | null
}

class AutoSyncService {
  private pushTimer: NodeJS.Timeout | null = null
  private pullTimer: NodeJS.Timeout | null = null
  private networkStatusTimer: NodeJS.Timeout | null = null
  private networkStatusDebounce: NodeJS.Timeout | null = null
  private networkStatusListener: ((event: any) => void) | null = null
  private config: AutoSyncConfig
  private isPushing = false
  private isPulling = false
  private lastPullVersion: string | null = null
  private _lastPushAt: Date | null = null
  private _lastPullAt: Date | null = null
  private _lastPushResult: string | null = null
  private _lastPullResult: string | null = null
  private _running = false

  constructor(config: Partial<AutoSyncConfig> = {}) {
    this.config = { ...DEFAULT_AUTO_SYNC_CONFIG, ...config }
  }

  get running(): boolean {
    return this._running
  }

  start(): void {
    if (!this.config.enabled) return
    if (this._running) return

    console.log('[AutoSync] Starting background sync...')
    console.log(`[AutoSync] Push interval: ${this.config.pushIntervalMs}ms, Pull interval: ${this.config.pullIntervalMs}ms`)

    this._running = true

    // Start push loop (drain pending syncs)
    this.pushTimer = setInterval(() => this.pushToCloud(), this.config.pushIntervalMs)

    // Start pull loop (check for IO definition changes)
    this.pullTimer = setInterval(() => this.pullFromCloud(), this.config.pullIntervalMs)

    // Network status: push on ConnectionFaulted value changes (instant via debounce)
    // Plus heartbeat every 30s as fallback
    this.networkStatusTimer = setInterval(() => {
      this.syncNetworkStatus().catch(() => {})
    }, 30000)
    this.setupNetworkStatusListener()

    // Do an initial push attempt after 5 seconds (let server fully start)
    setTimeout(() => this.pushToCloud(), 5000)

    // Start SSE client for real-time cloud updates (after 10s to let config load)
    setTimeout(async () => {
      try {
        const config = await configService.getConfig()
        if (config.remoteUrl && config.subsystemId) {
          const sseClient = startCloudSse({
            remoteUrl: config.remoteUrl,
            apiPassword: config.apiPassword || '',
            subsystemId: config.subsystemId,
          })
          // When SSE (re)connects, immediately push any pending items
          sseClient.onConnect(() => {
            console.log('[AutoSync] Cloud reconnected — pushing pending items now')
            this.pushToCloud()
          })
        }
      } catch {}

      // Subscribe to config changes so SSE client stays in sync
      configService.onChange((event) => {
        const cloudFieldsChanged = event.changedFields.some(f =>
          f === 'remoteUrl' || f === 'apiPassword' || f === 'subsystemId'
        )
        if (cloudFieldsChanged) {
          const c = event.currentConfig
          if (c.remoteUrl && c.subsystemId) {
            const sseClient = getCloudSseClient()
            if (sseClient) {
              sseClient.updateConfig({
                remoteUrl: c.remoteUrl,
                apiPassword: c.apiPassword || '',
                subsystemId: c.subsystemId,
              })
            } else {
              startCloudSse({
                remoteUrl: c.remoteUrl,
                apiPassword: c.apiPassword || '',
                subsystemId: c.subsystemId,
              })
            }
          }
        }
      })
    }, 10000)
  }

  private setupNetworkStatusListener(): void {
    try {
      // Listen for ConnectionFaulted tag changes via the PLC client
      const { getPlcClient } = require('@/lib/plc-client-manager')
      const client = getPlcClient()
      if (client) {
        this.networkStatusListener = (event: any) => {
          // Only react to ConnectionFaulted tags
          if (event.tagName && event.tagName.includes('ConnectionFaulted')) {
            // Debounce 500ms — multiple tags may change together (e.g., PLC reconnect)
            if (this.networkStatusDebounce) clearTimeout(this.networkStatusDebounce)
            this.networkStatusDebounce = setTimeout(() => {
              this.syncNetworkStatus().catch(() => {})
            }, 500)
          }
        }
        client.on('tagValueChanged', this.networkStatusListener)
        console.log('[AutoSync] Listening for ConnectionFaulted changes (instant push)')
      }
    } catch {
      // PLC client not available yet — heartbeat will cover it
    }
  }

  stop(): void {
    stopCloudSse()
    if (this.pushTimer) clearInterval(this.pushTimer)
    if (this.pullTimer) clearInterval(this.pullTimer)
    if (this.networkStatusTimer) clearInterval(this.networkStatusTimer)
    if (this.networkStatusDebounce) clearTimeout(this.networkStatusDebounce)
    // Remove tag change listener
    if (this.networkStatusListener) {
      try {
        const { getPlcClient } = require('@/lib/plc-client-manager')
        const client = getPlcClient()
        if (client) client.off('tagValueChanged', this.networkStatusListener)
      } catch {}
      this.networkStatusListener = null
    }
    this.pushTimer = null
    this.pullTimer = null
    this.networkStatusTimer = null
    this.networkStatusDebounce = null
    this._running = false
    console.log('[AutoSync] Stopped')
  }

  async getStatus(): Promise<AutoSyncStatus> {
    let pendingCount: number | null = null
    try {
      pendingCount = await prisma.pendingSync.count()
    } catch { /* db might not be ready */ }

    return {
      running: this._running,
      config: this.config,
      lastPushAt: this._lastPushAt?.toISOString() ?? null,
      lastPullAt: this._lastPullAt?.toISOString() ?? null,
      lastPushResult: this._lastPushResult,
      lastPullResult: this._lastPullResult,
      pendingCount,
    }
  }

  private async pushToCloud(): Promise<void> {
    if (this.isPushing) return
    this.isPushing = true

    try {
      const pendingSyncs = await prisma.pendingSync.findMany({
        orderBy: { createdAt: 'asc' },
        take: 50,
      })

      if (pendingSyncs.length === 0) {
        this._lastPushAt = new Date()
        this._lastPushResult = 'nothing to push'
        return
      }

      const config = await configService.getConfig()
      const remoteUrl = config.remoteUrl
      const apiPassword = config.apiPassword

      if (!remoteUrl) {
        this._lastPushResult = 'no remote URL configured'
        return
      }

      console.log(`[AutoSync] Pushing ${pendingSyncs.length} pending results to cloud...`)

      const updates = pendingSyncs.map(ps => ({
        id: ps.ioId,
        testedBy: ps.inspectorName,
        result: ps.testResult,
        comments: ps.comments,
        state: ps.state,
        version: Number(ps.version),
        timestamp: ps.timestamp?.toISOString(),
      }))

      const response = await fetch(`${remoteUrl}/api/sync/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiPassword || '',
        },
        body: JSON.stringify({ updates }),
        signal: AbortSignal.timeout(15000),
      })

      if (response.ok) {
        const syncedIds = pendingSyncs.map(ps => ps.id)
        await prisma.pendingSync.deleteMany({
          where: { id: { in: syncedIds } },
        })
        this._lastPushAt = new Date()
        this._lastPushResult = `pushed ${syncedIds.length} results`
        console.log(`[AutoSync] Pushed ${syncedIds.length} results to cloud`)

        try {
          const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
          getCloudSyncService().setConnectionState('connected')
        } catch { /* ignore */ }
      } else {
        this._lastPushResult = `HTTP ${response.status}`
        console.warn(`[AutoSync] Push failed: ${response.status}`)
        for (const ps of pendingSyncs) {
          await prisma.pendingSync.update({
            where: { id: ps.id },
            data: {
              retryCount: { increment: 1 },
              lastError: `HTTP ${response.status}`,
            },
          }).catch(() => {})
        }
      }
      // Clean up permanently failed PendingSync entries (retryCount > 100)
      try {
        const staleDeleted = await prisma.pendingSync.deleteMany({
          where: { retryCount: { gt: 100 } },
        })
        if (staleDeleted.count > 0) {
          console.warn(`[AutoSync] Cleaned up ${staleDeleted.count} permanently failed PendingSync entries (retryCount > 100)`)
        }
      } catch { /* ignore cleanup errors */ }

      // Also push pending change requests to cloud
      try {
        const pendingRequests = await prisma.changeRequest.findMany({
          where: { status: 'pending', cloudId: null },
        })
        if (pendingRequests.length > 0 && remoteUrl) {
          const resp = await fetch(`${remoteUrl}/api/sync/change-requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
            body: JSON.stringify({ requests: pendingRequests.map(r => ({
              ioId: r.ioId,
              requestType: r.requestType,
              currentValue: r.currentValue,
              requestedValue: r.requestedValue,
              structuredChanges: r.structuredChanges ? JSON.parse(r.structuredChanges) : null,
              reason: r.reason,
              requestedBy: r.requestedBy,
              createdAt: r.createdAt.toISOString(),
            })) }),
            signal: AbortSignal.timeout(10000),
          })
          if (resp.ok) {
            const data = await resp.json()
            // Update local records with cloud IDs
            if (data.requests) {
              for (const cr of data.requests) {
                if (cr.localId && cr.cloudId) {
                  await prisma.changeRequest.update({
                    where: { id: cr.localId },
                    data: { cloudId: cr.cloudId, status: 'synced' },
                  }).catch(() => {})
                }
              }
            }
            console.log(`[AutoSync] Pushed ${pendingRequests.length} change requests to cloud`)
          }
        }
      } catch { /* ignore change request sync errors */ }

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this._lastPushResult = `error: ${msg}`
      console.warn(`[AutoSync] Push error: ${msg}`)
    } finally {
      this.isPushing = false
    }
  }

  private async pullFromCloud(): Promise<void> {
    if (this.isPulling) return

    // Skip pull if SSE is connected and received events recently
    const sseClient = getCloudSseClient()
    if (sseClient?.isConnected && sseClient.lastEventAt &&
        Date.now() - sseClient.lastEventAt.getTime() < 90000) {
      this._lastPullAt = new Date()
      this._lastPullResult = 'skipped (SSE active)'
      return
    }

    this.isPulling = true

    try {
      const config = await configService.getConfig()
      const remoteUrl = config.remoteUrl
      const apiPassword = config.apiPassword
      const subsystemId = config.subsystemId

      if (!remoteUrl || !subsystemId) {
        this._lastPullResult = !remoteUrl ? 'no remote URL configured' : 'no subsystem configured'
        return
      }

      const cloudUrl = `${remoteUrl}/api/sync/subsystem/${subsystemId}`
      const response = await fetch(cloudUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiPassword || '',
        },
        signal: AbortSignal.timeout(15000),
      })

      if (!response.ok) {
        this._lastPullResult = `HTTP ${response.status}`
        return
      }

      const cloudData = await response.json()
      const cloudIos = Array.isArray(cloudData) ? cloudData : (cloudData.ios || cloudData.Ios || [])

      if (cloudIos.length === 0) {
        this._lastPullAt = new Date()
        this._lastPullResult = 'no IOs from cloud'
        return
      }

      // Quick change detection — include a sample of results to detect other users' test data
      const resultSample = cloudIos.slice(0, 10).map((io: { result?: string | null }) => io.result || '-').join('')
      const changeSignature = `${cloudIos.length}-${cloudIos[0]?.id}-${cloudIos[cloudIos.length - 1]?.id}-${resultSample}`
      if (changeSignature === this.lastPullVersion) {
        this._lastPullAt = new Date()
        this._lastPullResult = 'no changes detected'
        return
      }

      console.log(`[AutoSync] Pulling ${cloudIos.length} IO definitions from cloud...`)

      let updatedCount = 0
      let mergedResults = 0
      const subsystemIdNum = parseInt(subsystemId, 10)

      for (const cloudIo of cloudIos) {
        if (!cloudIo.name || cloudIo.id <= 0) continue

        try {
          // Check if local IO exists and compare versions
          const localIo = await prisma.io.findUnique({
            where: { id: cloudIo.id },
            select: { result: true, version: true },
          })

          const cloudVersion = BigInt(Number(cloudIo.version) || 0)
          const localVersion = localIo?.version ?? BigInt(0)

          const updateData: Record<string, unknown> = {
            name: cloudIo.name,
            description: cloudIo.description ?? null,
            order: cloudIo.order ?? null,
            version: cloudVersion,
          }
          if (cloudIo.tagType != null) {
            updateData.tagType = cloudIo.tagType
          }

          // Merge test results from cloud when:
          // 1. Local has no result, OR
          // 2. Cloud version is newer (someone tested/edited on cloud or another local tool)
          if (cloudIo.result !== undefined && (!localIo?.result || cloudVersion > localVersion)) {
            updateData.result = cloudIo.result || null
            updateData.timestamp = cloudIo.timestamp ?? null
            updateData.comments = cloudIo.comments ?? null
            mergedResults++
          }

          await prisma.io.upsert({
            where: { id: cloudIo.id },
            create: {
              id: cloudIo.id,
              subsystemId: subsystemIdNum,
              name: cloudIo.name,
              description: cloudIo.description ?? null,
              order: cloudIo.order ?? null,
              version: BigInt(Number(cloudIo.version) || 0),
              tagType: cloudIo.tagType ?? null,
              // Include cloud test results for new IOs (from other users)
              result: cloudIo.result ?? null,
              timestamp: cloudIo.timestamp ?? null,
              comments: cloudIo.comments ?? null,
            },
            update: updateData,
          })
          updatedCount++
        } catch {
          // Skip individual IO errors
        }
      }

      this.lastPullVersion = changeSignature
      this._lastPullAt = new Date()
      this._lastPullResult = `updated ${updatedCount} IOs${mergedResults > 0 ? `, merged ${mergedResults} results from other users` : ''}`

      if (updatedCount > 0) {
        console.log(`[AutoSync] Updated ${updatedCount} IOs from cloud${mergedResults > 0 ? ` (merged ${mergedResults} test results from other users)` : ''}`)

        // Broadcast to all connected browsers
        try {
          const broadcastUrl = process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast'
          await fetch(broadcastUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'IOsUpdated', count: updatedCount, source: 'auto-sync' }),
          })
        } catch { /* WS server might not be running */ }
      }

      // Pull back change request status updates from cloud
      try {
        const syncedRequests = await prisma.changeRequest.findMany({
          where: { cloudId: { not: null }, status: 'synced' },
        })
        if (syncedRequests.length > 0 && remoteUrl) {
          const cloudIds = syncedRequests.map(r => r.cloudId).filter(Boolean)
          const crResp = await fetch(`${remoteUrl}/api/sync/change-requests/status?ids=${cloudIds.join(',')}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
            signal: AbortSignal.timeout(10000),
          })
          if (crResp.ok) {
            const crData = await crResp.json()
            if (Array.isArray(crData.requests)) {
              for (const cr of crData.requests) {
                if (cr.cloudId && cr.status && cr.status !== 'synced') {
                  await prisma.changeRequest.updateMany({
                    where: { cloudId: cr.cloudId },
                    data: {
                      status: cr.status,
                      reviewedBy: cr.reviewedBy || undefined,
                      reviewNote: cr.reviewNote || undefined,
                      updatedAt: new Date(),
                    },
                  }).catch(() => {})
                }
              }
              console.log(`[AutoSync] Pulled ${crData.requests.length} change request status updates`)
            }
          }
        }
      } catch { /* ignore change request pull errors */ }

      try {
        const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
        getCloudSyncService().setConnectionState('connected')
      } catch { /* ignore */ }

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this._lastPullResult = `error: ${msg}`
      if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED')) {
        console.warn(`[AutoSync] Pull error: ${msg}`)
      }
    } finally {
      this.isPulling = false
    }
  }

  private async syncNetworkStatus(): Promise<void> {
    try {
      const config = await configService.getConfig()
      const { remoteUrl, apiPassword, subsystemId } = config

      if (!remoteUrl || !apiPassword || !subsystemId) return

      // Fetch current network status from local API
      const localResp = await fetch('http://localhost:3000/api/network/status', {
        signal: AbortSignal.timeout(3000),
      })
      if (!localResp.ok) return

      const statusData = await localResp.json()

      // Build tags map from the response
      const tags: Record<string, boolean> = {}
      const devices = statusData.devices || statusData
      if (Array.isArray(devices)) {
        for (const device of devices) {
          if (device.tag && typeof device.faulted === 'boolean') {
            tags[device.tag] = device.faulted
          } else if (device.tagName && typeof device.value === 'boolean') {
            tags[device.tagName] = device.value
          }
        }
      } else if (typeof devices === 'object') {
        // If it's already a key-value map
        Object.assign(tags, devices)
      }

      const payload = {
        subsystemId: parseInt(subsystemId, 10),
        connected: statusData.connected ?? true,
        tags,
        timestamp: new Date().toISOString(),
      }

      await fetch(`${remoteUrl}/api/sync/network-status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiPassword,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      })
    } catch (error) {
      // Log only unexpected errors, not connection failures
      const msg = error instanceof Error ? error.message : String(error)
      if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED') && !msg.includes('TimeoutError')) {
        console.warn(`[AutoSync] Network status sync error: ${msg}`)
      }
    }
  }
}

// Singleton
let autoSyncInstance: AutoSyncService | null = null

export function getAutoSyncService(): AutoSyncService | null {
  return autoSyncInstance
}

export function startAutoSync(config?: Partial<AutoSyncConfig>): AutoSyncService {
  if (autoSyncInstance) {
    autoSyncInstance.stop()
  }
  autoSyncInstance = new AutoSyncService(config)
  autoSyncInstance.start()
  return autoSyncInstance
}

export function stopAutoSync(): void {
  if (autoSyncInstance) {
    autoSyncInstance.stop()
    autoSyncInstance = null
  }
}
