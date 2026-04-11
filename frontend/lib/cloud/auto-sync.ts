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

import { db } from '@/lib/db-sqlite'
import type { PendingSync } from '@/lib/db-sqlite'
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
  private sseUnsubscribe: (() => void) | null = null
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
          if (this.sseUnsubscribe) this.sseUnsubscribe()
          this.sseUnsubscribe = sseClient.onConnect(() => {
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

  getStatus(): AutoSyncStatus {
    let pendingCount: number | null = null
    try {
      pendingCount = (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs').get() as any).count
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
      const pendingSyncs = db.prepare(
        'SELECT * FROM PendingSyncs ORDER BY CreatedAt ASC LIMIT 50'
      ).all() as PendingSync[]

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
        id: ps.IoId,
        testedBy: ps.InspectorName,
        result: ps.TestResult,
        comments: ps.Comments,
        state: ps.State,
        version: Number(ps.Version),
        timestamp: ps.Timestamp,
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
        const deletePlaceholders = syncedIds.map(() => '?').join(',')
        db.prepare(`DELETE FROM PendingSyncs WHERE id IN (${deletePlaceholders})`).run(...syncedIds)

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

        const updateStmt = db.prepare(
          'UPDATE PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?'
        )
        for (const ps of pendingSyncs) {
          try { updateStmt.run(`HTTP ${response.status}`, ps.id) } catch {}
        }
      }

      // Clean up permanently failed PendingSync entries (retryCount > 100)
      try {
        const staleResult = db.prepare('DELETE FROM PendingSyncs WHERE RetryCount > 100').run()
        if (staleResult.changes > 0) {
          console.warn(`[AutoSync] Cleaned up ${staleResult.changes} permanently failed PendingSync entries (retryCount > 100)`)
        }
      } catch { /* ignore cleanup errors */ }

      // Also push pending change requests to cloud
      try {
        const pendingRequests = db.prepare(
          'SELECT * FROM ChangeRequests WHERE Status = ? AND CloudId IS NULL LIMIT 100'
        ).all('pending') as any[]

        if (pendingRequests.length > 0 && remoteUrl) {
          const resp = await fetch(`${remoteUrl}/api/sync/change-requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
            body: JSON.stringify({ requests: pendingRequests.map(r => ({
              localId: r.id,
              ioId: r.IoId,
              requestType: r.RequestType,
              currentValue: r.CurrentValue,
              requestedValue: r.RequestedValue,
              structuredChanges: r.StructuredChanges ? JSON.parse(r.StructuredChanges) : null,
              reason: r.Reason,
              requestedBy: r.RequestedBy,
              createdAt: r.CreatedAt,
            })) }),
            signal: AbortSignal.timeout(10000),
          })
          if (resp.ok) {
            const data = await resp.json()
            // Mark ALL pushed requests as synced
            const ids = pendingRequests.map(r => r.id)
            const crPlaceholders = ids.map(() => '?').join(',')
            db.prepare(`UPDATE ChangeRequests SET Status = 'synced' WHERE id IN (${crPlaceholders})`).run(...ids)

            // If cloud returned cloudId mappings, update those too
            if (data.requests && Array.isArray(data.requests)) {
              const updateCrStmt = db.prepare('UPDATE ChangeRequests SET CloudId = ? WHERE id = ?')
              for (const cr of data.requests) {
                if (cr.localId && cr.cloudId) {
                  try { updateCrStmt.run(cr.cloudId, cr.localId) } catch {}
                }
              }
            }
            console.log(`[AutoSync] Pushed and marked ${ids.length} change requests as synced`)
          }
        }
      } catch { /* ignore change request sync errors */ }

      // Push pending L2 cell value changes to cloud
      // Strategy: re-read current local cell state for each pending sync to handle
      // rapid edits (e.g. Pass→Fail). The pendingSync was queued with the version
      // at edit time, but if more edits happened, we need to push the latest value.
      try {
        const l2Pending = db.prepare(
          'SELECT * FROM L2PendingSyncs ORDER BY CreatedAt ASC LIMIT 50'
        ).all() as any[]

        if (l2Pending.length > 0) {
          // Deduplicate: if multiple pending syncs exist for the same cell, only push
          // the latest one (delete the older ones).
          const cellMap = new Map<string, any>()
          const stalePendingIds: number[] = []
          for (const p of l2Pending) {
            const key = `${p.CloudDeviceId}-${p.CloudColumnId}`
            const existing = cellMap.get(key)
            if (!existing || p.id > existing.id) {
              if (existing) stalePendingIds.push(existing.id)
              cellMap.set(key, p)
            } else {
              stalePendingIds.push(p.id)
            }
          }
          if (stalePendingIds.length > 0) {
            const placeholders = stalePendingIds.map(() => '?').join(',')
            db.prepare(`DELETE FROM L2PendingSyncs WHERE id IN (${placeholders})`).run(...stalePendingIds)
          }

          const dedupedPending = Array.from(cellMap.values())

          // For each pending sync, look up the current local cell state by cloud IDs
          // → local IDs → fetch current Value and Version. This ensures we always push
          // the latest local state, not stale snapshots from the queue.
          const getLocalCell = db.prepare(`
            SELECT cv.Value, cv.Version
            FROM L2CellValues cv
            JOIN L2Devices d ON d.id = cv.DeviceId
            JOIN L2Columns c ON c.id = cv.ColumnId
            WHERE d.CloudId = ? AND c.CloudId = ?
          `)

          const l2Updates = dedupedPending.map((p: any) => {
            const local = getLocalCell.get(p.CloudDeviceId, p.CloudColumnId) as { Value: string | null; Version: number } | undefined
            return {
              pendingId: p.id,
              deviceId: p.CloudDeviceId,
              columnId: p.CloudColumnId,
              value: local ? local.Value : p.Value,
              version: local ? local.Version - 1 : p.Version,
              updatedBy: p.UpdatedBy,
            }
          })

          const l2Resp = await fetch(`${remoteUrl}/api/sync/l2/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
            body: JSON.stringify({ updates: l2Updates.map(({ pendingId, ...rest }) => rest) }),
            signal: AbortSignal.timeout(15000),
          })

          if (l2Resp.ok) {
            const l2Data = await l2Resp.json()

            // Build set of (deviceId, columnId) keys that succeeded
            const updatedKeys = new Set(
              (l2Data.updates || []).map((u: any) => `${u.deviceId}-${u.columnId}`)
            )

            // Delete pendingSyncs for cells that succeeded
            const successfulPendingIds = l2Updates
              .filter(u => updatedKeys.has(`${u.deviceId}-${u.columnId}`))
              .map(u => u.pendingId)

            if (successfulPendingIds.length > 0) {
              const placeholders = successfulPendingIds.map(() => '?').join(',')
              db.prepare(`DELETE FROM L2PendingSyncs WHERE id IN (${placeholders})`).run(...successfulPendingIds)
            }

            // For conflicts: increment retry count so they retry on next loop
            // (the next iteration will re-read latest local state)
            const conflictedPendingIds = l2Updates
              .filter(u => !updatedKeys.has(`${u.deviceId}-${u.columnId}`))
              .map(u => u.pendingId)

            for (const id of conflictedPendingIds) {
              try { db.prepare('UPDATE L2PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?').run('version conflict', id) } catch {}
            }

            const updatedCount = l2Data.updatedCount ?? successfulPendingIds.length
            const conflictCount = l2Data.conflictCount ?? conflictedPendingIds.length
            if (conflictCount > 0) {
              console.log(`[AutoSync] Pushed ${updatedCount} L2 cell updates to cloud (${conflictCount} conflicts — will retry with latest local state)`)
            } else if (updatedCount > 0) {
              console.log(`[AutoSync] Pushed ${updatedCount} L2 cell updates to cloud`)
            }
          } else {
            for (const p of dedupedPending) {
              try { db.prepare('UPDATE L2PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?').run(`HTTP ${l2Resp.status}`, p.id) } catch {}
            }
          }
        }

        // Clean up permanently failed L2PendingSync entries (retryCount > 100)
        try {
          const l2StaleResult = db.prepare('DELETE FROM L2PendingSyncs WHERE RetryCount > 100').run()
          if (l2StaleResult.changes > 0) {
            console.warn(`[AutoSync] Cleaned up ${l2StaleResult.changes} permanently failed L2PendingSync entries (retryCount > 100)`)
          }
        } catch { /* ignore cleanup errors */ }
      } catch { /* ignore L2 sync errors */ }

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this._lastPushResult = `error: ${msg}`
      console.warn(`[AutoSync] Push error: ${msg}`)
    } finally {
      this.isPushing = false
    }
  }

  private _lastManualPullAt = 0

  /** Call after a manual Pull IOs to prevent auto-sync from overwriting with stale data */
  markManualPull(): void {
    this._lastManualPullAt = Date.now()
  }

  private async pullFromCloud(): Promise<void> {
    if (this.isPulling) return

    // Skip auto-pull if a manual pull just happened (within 30 seconds)
    // The manual pull already has the correct data — auto-pull would race with stale config
    if (Date.now() - this._lastManualPullAt < 30000) {
      this._lastPullResult = 'skipped (recent manual pull)'
      return
    }

    this.isPulling = true

    try {
      const config = await configService.getConfig()
      const remoteUrl = config.remoteUrl
      const apiPassword = config.apiPassword
      const subsystemId = config.subsystemId

      // Keep SSE client in sync with current config
      const sseClient = getCloudSseClient()
      if (sseClient && config.remoteUrl && config.subsystemId) {
        sseClient.updateConfig({
          remoteUrl: config.remoteUrl,
          apiPassword: config.apiPassword || '',
          subsystemId: config.subsystemId,
        })
      }

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

      const selectStmt = db.prepare('SELECT Result, Version FROM Ios WHERE id = ?')
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO Ios (id, SubsystemId, Name, Description, "Order", Version, TagType, Result, Timestamp, Comments)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const updateDefStmt = db.prepare(`
        UPDATE Ios SET Name = ?, Description = ?, "Order" = ?, Version = ?, TagType = COALESCE(?, TagType)
        WHERE id = ?
      `)
      const updateWithResultStmt = db.prepare(`
        UPDATE Ios SET Name = ?, Description = ?, "Order" = ?, Version = ?, TagType = COALESCE(?, TagType),
        Result = ?, Timestamp = ?, Comments = ?
        WHERE id = ?
      `)

      const pullTransaction = db.transaction(() => {
        // Check if subsystem changed — if so, clear all IOs first
        const existingSubIds = db.prepare('SELECT DISTINCT SubsystemId FROM Ios').all() as { SubsystemId: number }[]
        const hasOtherSubsystems = existingSubIds.some(s => s.SubsystemId !== subsystemIdNum)
        if (hasOtherSubsystems) {
          console.log(`[AutoSync] Subsystem changed (had ${existingSubIds.map(s => s.SubsystemId).join(',')}, now ${subsystemIdNum}) — clearing all IOs`)
          db.exec('DELETE FROM Ios')
        }

        for (const cloudIo of cloudIos) {
          if (!cloudIo.name || cloudIo.id <= 0) continue

          try {
            const localIo = selectStmt.get(cloudIo.id) as { Result: string | null, Version: number } | undefined

            const cloudVersion = Number(cloudIo.version) || 0
            const localVersion = localIo?.Version ?? 0

            // Determine if we should merge results
            const shouldMergeResult = cloudIo.result !== undefined &&
              (!localIo?.Result || cloudVersion > localVersion)

            if (!localIo) {
              // Insert new IO
              insertStmt.run(
                cloudIo.id,
                subsystemIdNum,
                cloudIo.name,
                cloudIo.description ?? null,
                cloudIo.order ?? null,
                cloudVersion,
                cloudIo.tagType ?? null,
                cloudIo.result ?? null,
                cloudIo.timestamp ?? null,
                cloudIo.comments ?? null,
              )
            } else if (shouldMergeResult) {
              updateWithResultStmt.run(
                cloudIo.name,
                cloudIo.description ?? null,
                cloudIo.order ?? null,
                cloudVersion,
                cloudIo.tagType ?? null,
                cloudIo.result || null,
                cloudIo.timestamp ?? null,
                cloudIo.comments ?? null,
                cloudIo.id,
              )
              mergedResults++
            } else {
              updateDefStmt.run(
                cloudIo.name,
                cloudIo.description ?? null,
                cloudIo.order ?? null,
                cloudVersion,
                cloudIo.tagType ?? null,
                cloudIo.id,
              )
            }
            updatedCount++
          } catch {
            // Skip individual IO errors
          }
        }
      })

      pullTransaction()

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
        const syncedRequests = db.prepare(
          "SELECT * FROM ChangeRequests WHERE CloudId IS NOT NULL AND Status = 'synced' LIMIT 100"
        ).all() as any[]

        if (syncedRequests.length > 0 && remoteUrl) {
          const cloudIds = syncedRequests.map(r => r.CloudId).filter(Boolean)
          const crResp = await fetch(`${remoteUrl}/api/sync/change-requests/status?ids=${cloudIds.join(',')}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiPassword || '' },
            signal: AbortSignal.timeout(10000),
          })
          if (crResp.ok) {
            const crData = await crResp.json()
            if (Array.isArray(crData.requests)) {
              const updateCrStatusStmt = db.prepare(
                'UPDATE ChangeRequests SET Status = ?, ReviewedBy = ?, ReviewNote = ?, UpdatedAt = ? WHERE CloudId = ?'
              )
              for (const cr of crData.requests) {
                if (cr.cloudId && cr.status && cr.status !== 'synced') {
                  try {
                    updateCrStatusStmt.run(
                      cr.status,
                      cr.reviewedBy || null,
                      cr.reviewNote || null,
                      new Date().toISOString(),
                      cr.cloudId,
                    )
                  } catch {}
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
          const subsystemIdNum = parseInt(String(subsystemId), 10)
          const rings = db.prepare('SELECT * FROM NetworkRings WHERE SubsystemId = ?').all(subsystemIdNum) as any[]

          for (const ring of rings) {
            if (ring.McmTag) tags[ring.McmTag] = getPlcClient().readTagCached(ring.McmTag)

            const nodes = db.prepare('SELECT * FROM NetworkNodes WHERE RingId = ?').all(ring.id) as any[]
            for (const node of nodes) {
              if (node.StatusTag) tags[node.StatusTag] = getPlcClient().readTagCached(node.StatusTag)

              const ports = db.prepare('SELECT * FROM NetworkPorts WHERE NodeId = ?').all(node.id) as any[]
              for (const port of ports) {
                if (port.StatusTag) tags[port.StatusTag] = getPlcClient().readTagCached(port.StatusTag)
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
          const zones = db.prepare('SELECT * FROM EStopZones').all() as any[]

          for (const zone of zones) {
            const epcs = db.prepare('SELECT * FROM EStopEpcs WHERE ZoneId = ?').all(zone.id) as any[]
            for (const epc of epcs) {
              if (epc.CheckTag) tags[epc.CheckTag] = getPlcClient().readTagCached(epc.CheckTag)

              const ioPoints = db.prepare('SELECT * FROM EStopIoPoints WHERE EpcId = ?').all(epc.id) as any[]
              for (const ioPoint of ioPoints) {
                if (ioPoint.Tag) tags[ioPoint.Tag] = getPlcClient().readTagCached(ioPoint.Tag)
              }

              const vfds = db.prepare('SELECT * FROM EStopVfds WHERE EpcId = ?').all(epc.id) as any[]
              for (const vfd of vfds) {
                if (vfd.StoTag) tags[vfd.StoTag] = getPlcClient().readTagCached(vfd.StoTag)
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
  if (autoSyncInstance && autoSyncInstance.running) {
    // Already running — don't restart (preserves SSE connection)
    return autoSyncInstance
  }
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
