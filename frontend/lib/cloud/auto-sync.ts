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
import { pendingSyncRepository } from '@/lib/db/repositories/pending-sync-repository'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import { mapPendingSyncToIoUpdate } from '@/lib/cloud/pending-sync-utils'

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
      } catch (err) {
        console.warn('[AutoSync] Failed to start SSE client:', err)
      }

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

      const config = await configService.getConfig()
      const remoteUrl = config.remoteUrl
      const apiPassword = config.apiPassword

      if (!remoteUrl) {
        this._lastPushResult = 'no remote URL configured'
        return
      }

      let syncedIoCount = 0
      let failedIoCount = 0
      if (pendingSyncs.length > 0) {
        console.log(`[AutoSync] Pushing ${pendingSyncs.length} pending results to cloud...`)

        const syncService = getCloudSyncService()
        const blockedIoIds = new Set<number>()

        for (const pending of pendingSyncs) {
          if (blockedIoIds.has(pending.IoId)) {
            continue
          }

          const synced = await syncService.syncIoUpdate(mapPendingSyncToIoUpdate(pending))
          if (synced) {
            pendingSyncRepository.delete(pending.id)
            syncedIoCount++
          } else {
            blockedIoIds.add(pending.IoId)
            pendingSyncRepository.recordFailure(pending.id, 'Background sync failed')
            failedIoCount++
          }
        }

        if (syncedIoCount > 0) {
          console.log(`[AutoSync] Pushed ${syncedIoCount} results to cloud`)
        }
      }

      this._lastPushAt = new Date()
      this._lastPushResult =
        syncedIoCount > 0 || failedIoCount > 0
          ? `pushed ${syncedIoCount} results${failedIoCount > 0 ? `, ${failedIoCount} failed` : ''}`
          : 'nothing to push'

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
            const acknowledgedRequests = Array.isArray(data.requests) ? data.requests : []
            const acknowledgedIds = acknowledgedRequests
              .map((cr: any) => Number(cr.localId))
              .filter((id: number) => Number.isInteger(id) && id > 0)

            if (acknowledgedIds.length > 0) {
              const crPlaceholders = acknowledgedIds.map(() => '?').join(',')
              db.prepare(`UPDATE ChangeRequests SET Status = 'synced' WHERE id IN (${crPlaceholders})`).run(...acknowledgedIds)

              const updateCrStmt = db.prepare('UPDATE ChangeRequests SET CloudId = ? WHERE id = ?')
              for (const cr of acknowledgedRequests) {
                if (cr.localId && cr.cloudId) {
                  try { updateCrStmt.run(cr.cloudId, cr.localId) } catch (e) { console.warn('[AutoSync] Failed to update CR cloudId:', e) }
                }
              }
            }
            console.log(`[AutoSync] Cloud acknowledged ${acknowledgedIds.length}/${pendingRequests.length} change requests`)
          }
        }
      } catch (err) {
        console.warn('[AutoSync] Change request push error:', err instanceof Error ? err.message : err)
      }

      // Push pending L2 cell value changes to cloud
      // Strategy: re-read latest local VALUE (handles rapid edits — always push final
      // value), but use the OLDEST stored pending sync version as the base version.
      //
      // Why not local.Version - 1? When multiple people edit the same cell while the
      // first push is in-flight (slow/bad network), local version jumps ahead by N
      // but cloud hasn't moved. Using local.Version - 1 sends a base version the
      // cloud has never seen → permanent version conflict.
      //
      // The oldest pending sync's Version was captured at the moment of the first
      // failed edit — it's what the cloud actually had at that point.
      try {
        const l2Pending = db.prepare(
          'SELECT * FROM L2PendingSyncs ORDER BY CreatedAt ASC LIMIT 50'
        ).all() as any[]

        if (l2Pending.length > 0) {
          // Deduplicate: if multiple pending syncs exist for the same cell, keep the
          // one with the LOWEST Version (closest to what cloud actually has) and the
          // LATEST value. Delete the rest.
          const cellMap = new Map<string, any>()
          const stalePendingIds: number[] = []
          for (const p of l2Pending) {
            const key = `${p.CloudDeviceId}-${p.CloudColumnId}`
            const existing = cellMap.get(key)
            if (!existing) {
              cellMap.set(key, p)
            } else {
              // Keep the row with the LOWEST version (= closest to cloud's real version)
              if (p.Version < existing.Version) {
                stalePendingIds.push(existing.id)
                cellMap.set(key, p)
              } else {
                stalePendingIds.push(p.id)
              }
            }
          }
          if (stalePendingIds.length > 0) {
            const placeholders = stalePendingIds.map(() => '?').join(',')
            db.prepare(`DELETE FROM L2PendingSyncs WHERE id IN (${placeholders})`).run(...stalePendingIds)
          }

          const dedupedPending = Array.from(cellMap.values())

          // For each pending sync, look up the current local cell VALUE (latest),
          // but use the stored Version from PendingSync (the cloud's expected version).
          const getLocalCell = db.prepare(`
            SELECT cv.Value, cv.Version, cv.UpdatedBy
            FROM L2CellValues cv
            JOIN L2Devices d ON d.id = cv.DeviceId
            JOIN L2Columns c ON c.id = cv.ColumnId
            WHERE d.CloudId = ? AND c.CloudId = ?
          `)

          const l2Updates = dedupedPending.map((p: any) => {
            const local = getLocalCell.get(p.CloudDeviceId, p.CloudColumnId) as { Value: string | null; Version: number; UpdatedBy: string | null } | undefined
            return {
              pendingId: p.id,
              deviceId: p.CloudDeviceId,
              columnId: p.CloudColumnId,
              value: local ? local.Value : p.Value,                // latest local value
              version: p.Version,                                  // stored base version (what cloud has)
              updatedBy: local?.UpdatedBy || p.UpdatedBy,
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

            // Delete ALL pendingSyncs for cells that succeeded — not just the one
            // we pushed, but any that accumulated while this push was in flight.
            const deleteAllForCell = db.prepare('DELETE FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ?')
            let successCount = 0
            for (const u of l2Updates) {
              if (updatedKeys.has(`${u.deviceId}-${u.columnId}`)) {
                deleteAllForCell.run(u.deviceId, u.columnId)
                successCount++
              }
            }

            // For conflicts: increment retry count so they retry on next loop
            const conflictedUpdates = l2Updates
              .filter(u => !updatedKeys.has(`${u.deviceId}-${u.columnId}`))

            for (const u of conflictedUpdates) {
              try { db.prepare('UPDATE L2PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?').run('version conflict', u.pendingId) } catch (e) { console.warn('[AutoSync] Failed to update L2 retry count:', e) }
            }

            const updatedCount = l2Data.updatedCount ?? successCount
            const conflictCount = l2Data.conflictCount ?? conflictedUpdates.length
            if (conflictCount > 0) {
              console.log(`[AutoSync] Pushed ${updatedCount} L2 cell updates to cloud (${conflictCount} conflicts — will retry with stored base version)`)
            } else if (updatedCount > 0) {
              console.log(`[AutoSync] Pushed ${updatedCount} L2 cell updates to cloud`)
            }
          } else {
            for (const p of dedupedPending) {
              try { db.prepare('UPDATE L2PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?').run(`HTTP ${l2Resp.status}`, p.id) } catch (e) { console.warn('[AutoSync] Failed to update L2 retry count:', e) }
            }
          }
        }

      } catch (err) {
        console.warn('[AutoSync] L2 cell sync error:', err instanceof Error ? err.message : err)
      }

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

      const pendingIoCount = (db.prepare('SELECT COUNT(*) as count FROM PendingSyncs').get() as { count: number }).count
      const pendingL2Count = (db.prepare('SELECT COUNT(*) as count FROM L2PendingSyncs').get() as { count: number }).count
      if (pendingIoCount > 0 || pendingL2Count > 0) {
        this._lastPullResult = `skipped (local pending syncs: io=${pendingIoCount}, l2=${pendingL2Count})`
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
      const pendingIoIds = new Set(
        (db.prepare('SELECT DISTINCT IoId FROM PendingSyncs').all() as Array<{ IoId: number }>).map(row => row.IoId)
      )

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
        // Auto-pull must never switch subsystems behind the user's back.
        const existingSubIds = db.prepare('SELECT DISTINCT SubsystemId FROM Ios').all() as { SubsystemId: number }[]
        const hasOtherSubsystems = existingSubIds.some(s => s.SubsystemId !== subsystemIdNum)
        if (hasOtherSubsystems) {
          throw new Error(`auto-pull refused subsystem switch from ${existingSubIds.map(s => s.SubsystemId).join(',')} to ${subsystemIdNum}`)
        }

        for (const cloudIo of cloudIos) {
          if (!cloudIo.name || cloudIo.id <= 0) continue

          try {
            const localIo = selectStmt.get(cloudIo.id) as { Result: string | null, Version: number } | undefined

            const cloudVersion = Number(cloudIo.version) || 0
            const localVersion = localIo?.Version ?? 0
            const hasLocalPendingSync = pendingIoIds.has(cloudIo.id)

            // Never overwrite local dirty state. Only merge cloud results/comments when cloud is newer
            // and this IO has no unsynced local writes waiting in PendingSyncs.
            const shouldMergeResult =
              cloudIo.result !== undefined &&
              !hasLocalPendingSync &&
              cloudVersion > localVersion

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
                  } catch (e) { console.warn('[AutoSync] Failed to update CR status:', e) }
                }
              }
              console.log(`[AutoSync] Pulled ${crData.requests.length} change request status updates`)
            }
          }
        }
      } catch (err) {
        console.warn('[AutoSync] Change request pull error:', err instanceof Error ? err.message : err)
      }

      try {
        const { getCloudSyncService } = await import('@/lib/cloud/cloud-sync-service')
        getCloudSyncService().setConnectionState('connected')
      } catch (err) {
        console.warn('[AutoSync] Failed to set cloud connection state:', err)
      }

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

      // Only push estop status when PLC is actually connected.
      // If PLC is not connected, skip entirely — avoids overwriting
      // live data from another tool instance on the same subsystem.
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
        // PLC not available — skip push
      }

      // Don't send disconnected status to cloud — it would overwrite
      // live data from a tool that IS connected to the PLC
      if (!connected) return

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
