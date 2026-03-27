/**
 * Automatic Bidirectional Sync Service
 *
 * Runs in the background on the server:
 * - Push: Drains PendingSync queue to cloud every 30s
 * - Pull: On SSE (re)connect only — no polling. SSE is the primary real-time channel;
 *         a full pull on reconnect catches any events missed during disconnect.
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
  enabled: boolean          // default true
  maxRetries: number        // default 3
}

const DEFAULT_AUTO_SYNC_CONFIG: AutoSyncConfig = {
  pushIntervalMs: 30000,
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
  private networkStatusTimer: NodeJS.Timeout | null = null
  private estopStatusTimer: NodeJS.Timeout | null = null
  private config: AutoSyncConfig
  private isPushing = false
  private isPulling = false
  private isPushingNetworkStatus = false
  private isPushingEstopStatus = false
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
    console.log(`[AutoSync] Push interval: ${this.config.pushIntervalMs}ms, Pull: on SSE (re)connect only`)

    this._running = true

    // Start push loop (drain pending syncs)
    this.pushTimer = setInterval(() => this.pushToCloud(), this.config.pushIntervalMs)

    // Do an initial push attempt after 5 seconds (let server fully start)
    setTimeout(() => this.pushToCloud(), 5000)

    // Push network status to cloud every 5 seconds (lightweight, tag booleans only)
    this.networkStatusTimer = setInterval(() => this.pushNetworkStatus(), 5000)

    // Push estop status to cloud every 5 seconds
    this.estopStatusTimer = setInterval(() => this.pushEstopStatus(), 5000)

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
          // When SSE (re)connects, push pending items + pull to catch missed events
          sseClient.onConnect(() => {
            console.log('[AutoSync] Cloud SSE connected — pushing pending + pulling to catch up')
            this.pushToCloud()
            this.pullFromCloud()
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

  stop(): void {
    stopCloudSse()
    if (this.pushTimer) clearInterval(this.pushTimer)
    if (this.networkStatusTimer) clearInterval(this.networkStatusTimer)
    if (this.estopStatusTimer) clearInterval(this.estopStatusTimer)
    this.pushTimer = null
    this.networkStatusTimer = null
    this.estopStatusTimer = null
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
              localId: r.id, // include local ID so cloud can map it back
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
            // Mark ALL pushed requests as synced regardless of cloud response format
            // This prevents re-sending old requests forever
            const ids = pendingRequests.map(r => r.id)
            await prisma.changeRequest.updateMany({
              where: { id: { in: ids } },
              data: { status: 'synced' },
            })
            // If cloud returned cloudId mappings, update those too
            if (data.requests && Array.isArray(data.requests)) {
              for (const cr of data.requests) {
                if (cr.localId && cr.cloudId) {
                  await prisma.changeRequest.update({
                    where: { id: cr.localId },
                    data: { cloudId: cr.cloudId },
                  }).catch(() => {})
                }
              }
            }
            console.log(`[AutoSync] Pushed and marked ${ids.length} change requests as synced`)
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

      // Change detection — hash all versions to detect any change anywhere
      const versionHash = cloudIos.map((io: any) => `${io.id}:${io.version}:${io.result || '-'}`).join('|')
      if (versionHash === this.lastPullVersion) {
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

          // Merge test results when local has none OR cloud version is newer
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

      this.lastPullVersion = versionHash
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

  private async pushNetworkStatus(): Promise<void> {
    if (this.isPushingNetworkStatus) return
    this.isPushingNetworkStatus = true

    try {
      const config = await configService.getConfig()
      const remoteUrl = config.remoteUrl
      const apiPassword = config.apiPassword
      const subsystemId = config.subsystemId

      if (!remoteUrl || !subsystemId) return

      // Read PLC connection + network tag values
      let connected = false
      let tags: Record<string, boolean | null> = {}

      try {
        const { hasPlcClient, getPlcClient } = await import('@/lib/plc-client-manager')
        if (hasPlcClient() && getPlcClient().isConnected) {
          connected = true
          // Read network tags from database
          const rings = await prisma.networkRing.findMany({
            where: { subsystemId: parseInt(String(subsystemId), 10) },
            include: { nodes: { include: { ports: true } } },
          })

          for (const ring of rings) {
            if (ring.mcmTag) tags[ring.mcmTag] = getPlcClient().readTagCached(ring.mcmTag)
            for (const node of ring.nodes) {
              if (node.statusTag) tags[node.statusTag] = getPlcClient().readTagCached(node.statusTag)
              for (const port of node.ports) {
                if (port.statusTag) tags[port.statusTag] = getPlcClient().readTagCached(port.statusTag)
              }
            }
          }
        }
      } catch {
        // PLC not available — send disconnected status
      }

      await fetch(`${remoteUrl}/api/sync/network-status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiPassword || '',
        },
        body: JSON.stringify({
          subsystemId: parseInt(String(subsystemId), 10),
          connected,
          tags,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      // Network status push is best-effort — don't log noise
    } finally {
      this.isPushingNetworkStatus = false
    }
  }

  private async pushEstopStatus(): Promise<void> {
    if (this.isPushingEstopStatus) return
    this.isPushingEstopStatus = true

    try {
      const config = await configService.getConfig()
      const remoteUrl = config.remoteUrl
      const apiPassword = config.apiPassword
      const subsystemId = config.subsystemId

      if (!remoteUrl || !subsystemId) return

      // Read PLC connection + estop tag values
      let connected = false
      let tags: Record<string, boolean | null> = {}

      try {
        const { hasPlcClient, getPlcClient } = await import('@/lib/plc-client-manager')
        if (hasPlcClient() && getPlcClient().isConnected) {
          connected = true
          // Read estop tags from database
          const zones = await prisma.eStopZone.findMany({
            include: {
              epcs: {
                include: {
                  ioPoints: true,
                  vfds: true,
                },
              },
            },
          })

          for (const zone of zones) {
            for (const epc of zone.epcs) {
              if (epc.checkTag) tags[epc.checkTag] = getPlcClient().readTagCached(epc.checkTag)
              for (const ioPoint of epc.ioPoints) {
                if (ioPoint.tag) tags[ioPoint.tag] = getPlcClient().readTagCached(ioPoint.tag)
              }
              for (const vfd of epc.vfds) {
                if (vfd.stoTag) tags[vfd.stoTag] = getPlcClient().readTagCached(vfd.stoTag)
              }
            }
          }
        }
      } catch {
        // PLC not available — send disconnected status
      }

      await fetch(`${remoteUrl}/api/sync/estop-status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiPassword || '',
        },
        body: JSON.stringify({
          subsystemId: parseInt(String(subsystemId), 10),
          connected,
          tags,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      // Estop status push is best-effort — don't log noise
    } finally {
      this.isPushingEstopStatus = false
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
