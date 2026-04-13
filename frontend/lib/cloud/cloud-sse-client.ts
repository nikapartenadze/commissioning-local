/**
 * Cloud SSE Client — Real-time updates from cloud server
 *
 * Maintains a persistent SSE (Server-Sent Events) connection to the cloud.
 * When other users test IOs, the cloud pushes updates instantly instead of
 * waiting for the 60s polling pull.
 *
 * Also provides live cloud connection status (replaces health check polling).
 */

import { db } from '@/lib/db-sqlite'

// SSE connection states
export type SseConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export interface CloudSseConfig {
  remoteUrl: string
  apiPassword: string
  subsystemId: string | number
}

const WS_BROADCAST_URL = process.env.WS_BROADCAST_URL || 'http://localhost:3102/broadcast'

class CloudSseClient {
  private config: CloudSseConfig
  private abortController: AbortController | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = 5000
  private maxReconnectDelay = 60000
  private _connectionState: SseConnectionState = 'disconnected'
  private _lastEventAt: Date | null = null
  private _intentionalDisconnect = false
  private recentPushedIds = new Set<number>() // Skip echoes of our own pushes
  private recentPushedL2Keys = new Set<string>() // Key format: "deviceId-columnId"
  private _onConnectCallbacks = new Set<() => void>()

  constructor(config: CloudSseConfig) {
    this.config = config
  }

  /** Register a callback to fire when SSE (re)connects. Returns unsubscribe function. */
  onConnect(callback: () => void): () => void {
    this._onConnectCallbacks.add(callback)
    return () => { this._onConnectCallbacks.delete(callback) }
  }

  get connectionState(): SseConnectionState { return this._connectionState }
  get isConnected(): boolean { return this._connectionState === 'connected' }
  get lastEventAt(): Date | null { return this._lastEventAt }

  /** Track an IO we just pushed so we skip the echo from SSE */
  trackPushedId(ioId: number): void {
    this.recentPushedIds.add(ioId)
    setTimeout(() => this.recentPushedIds.delete(ioId), 30000)
  }

  /** Track an L2 cell we just pushed so we skip the echo from SSE */
  trackPushedL2Id(cloudDeviceId: number, cloudColumnId: number): void {
    const key = `${cloudDeviceId}-${cloudColumnId}`
    this.recentPushedL2Keys.add(key)
    setTimeout(() => this.recentPushedL2Keys.delete(key), 30000)
  }

  async connect(): Promise<void> {
    if (this._connectionState === 'connected' || this._connectionState === 'connecting') return
    this._intentionalDisconnect = false
    this.reconnectDelay = 5000
    await this.startStream()
  }

  disconnect(): void {
    this._intentionalDisconnect = true
    this.cleanup()
    this.setConnectionState('disconnected')
    console.log('[CloudSSE] Disconnected')
  }

  updateConfig(config: CloudSseConfig): void {
    const changed = this.config.remoteUrl !== config.remoteUrl ||
      this.config.subsystemId !== config.subsystemId ||
      this.config.apiPassword !== config.apiPassword
    this.config = config
    if (changed && this._connectionState !== 'disconnected') {
      console.log('[CloudSSE] Config changed, reconnecting...')
      this.cleanup()
      this.startStream()
    }
  }

  private cleanup(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setConnectionState(state: SseConnectionState): void {
    if (this._connectionState === state) return
    this._connectionState = state

    // Broadcast to all browser tabs via WebSocket
    try {
      fetch(WS_BROADCAST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'CloudConnectionChanged',
          connected: state === 'connected',
          state,
        }),
      }).catch(() => {})
    } catch {}
  }

  private async startStream(): Promise<void> {
    const { remoteUrl, apiPassword, subsystemId } = this.config
    if (!remoteUrl || !subsystemId) return

    this.setConnectionState(this._connectionState === 'disconnected' ? 'connecting' : 'reconnecting')
    this.abortController = new AbortController()

    const url = `${remoteUrl}/api/sync/events?subsystemId=${subsystemId}`

    try {
      console.log(`[CloudSSE] Connecting to ${remoteUrl}...`)

      const response = await fetch(url, {
        headers: {
          'Accept': 'text/event-stream',
          'X-API-Key': apiPassword || '',
        },
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      if (!response.body) {
        throw new Error('No response body')
      }

      this.setConnectionState('connected')
      this.reconnectDelay = 5000 // Reset on successful connect
      console.log('[CloudSSE] Connected — receiving real-time updates')

      // Fire onConnect callbacks (e.g., trigger immediate pending sync push)
      Array.from(this._onConnectCallbacks).forEach(cb => {
        try { cb() } catch {}
      })

      // Parse SSE stream
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Split on double newlines (SSE event separator)
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''

        for (const event of events) {
          const dataLines = event.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())

          if (dataLines.length > 0) {
            const data = dataLines.join('\n')
            try {
              this.handleEvent(JSON.parse(data))
            } catch {
              // Skip malformed events
            }
          }
        }
      }

      // Stream ended cleanly
      if (!this._intentionalDisconnect) {
        this.scheduleReconnect()
      }
    } catch (error) {
      if (this._intentionalDisconnect) return
      const msg = error instanceof Error ? error.message : String(error)
      if (msg !== 'This operation was aborted') {
        console.warn(`[CloudSSE] Connection error: ${msg}`)
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this._intentionalDisconnect) return
    this.setConnectionState('reconnecting')
    console.log(`[CloudSSE] Reconnecting in ${this.reconnectDelay / 1000}s...`)
    this.reconnectTimer = setTimeout(() => {
      this.startStream()
    }, this.reconnectDelay)
    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay)
  }

  private handleEvent(event: any): void {
    this._lastEventAt = new Date()

    switch (event.type) {
      case 'connected':
      case 'heartbeat':
      case 'ping':
        // Keep-alive, no action needed
        break

      case 'io-updated':
      case 'io_updated': {
        const ioData = event.data || event
        this.handleIoUpdated(ioData)
        break
      }

      case 'io-batch-updated':
      case 'io_batch_updated':
      case 'batch_ios_updated': {
        const batchData = event.data || event.updates || event
        if (Array.isArray(batchData)) {
          for (const update of batchData) {
            this.handleIoUpdated(update)
          }
        }
        break
      }

      case 'l2-cell-updated':
      case 'l2_cell_updated': {
        const l2Data = event.data || event
        this.handleL2CellUpdated(l2Data).catch(() => {})
        break
      }

      default:
        // Unknown event type — ignore
        break
    }
  }

  private handleIoUpdated(event: any): void {
    const ioId = event.id
    if (!ioId) return

    // Skip echoes of our own pushes
    if (this.recentPushedIds.has(ioId)) return

    try {
      const localIo = db.prepare('SELECT Result, Version FROM Ios WHERE id = ?').get(ioId) as
        { Result: string | null, Version: number } | undefined

      if (!localIo) return // IO doesn't exist locally

      const setClauses: string[] = []
      const params: any[] = []

      // Always update definitions if provided
      if (event.name !== undefined) { setClauses.push('Name = ?'); params.push(event.name) }
      if (event.description !== undefined) { setClauses.push('Description = ?'); params.push(event.description) }
      if (event.order !== undefined) { setClauses.push('"Order" = ?'); params.push(event.order) }
      if (event.tagType !== undefined) { setClauses.push('TagType = ?'); params.push(event.tagType) }
      if (event.version !== undefined) { setClauses.push('Version = ?'); params.push(Number(event.version) || 0) }

      // Merge test results if cloud version is newer (includes clears)
      const cloudVersion = Number(event.version) || 0
      const localVersion = localIo.Version ?? 0
      console.log(`[SSE] IO ${ioId}: cloud v${cloudVersion} vs local v${localVersion}, result=${event.result}, localResult=${localIo.Result}`)

      if (cloudVersion > localVersion) {
        if (event.result !== undefined) { setClauses.push('Result = ?'); params.push(event.result ?? null) }
        if (event.timestamp !== undefined) { setClauses.push('Timestamp = ?'); params.push(event.timestamp ?? null) }
        if (event.comments !== undefined) { setClauses.push('Comments = ?'); params.push(event.comments ?? null) }
      } else if (!localIo.Result && event.result) {
        // Local has no result, cloud does — accept regardless of version
        setClauses.push('Result = ?'); params.push(event.result)
        setClauses.push('Timestamp = ?'); params.push(event.timestamp ?? null)
        setClauses.push('Comments = ?'); params.push(event.comments ?? null)
      }

      if (setClauses.length === 0) return

      params.push(ioId)
      db.prepare(`UPDATE Ios SET ${setClauses.join(', ')} WHERE id = ?`).run(...params)

      // Broadcast to browser tabs
      try {
        fetch(WS_BROADCAST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'UpdateIO',
            id: ioId,
            result: event.result !== undefined ? (event.result || 'Not Tested') : (localIo.Result || 'Not Tested'),
            state: '',
            timestamp: event.timestamp ?? '',
            comments: event.comments ?? '',
          }),
        }).catch(() => {})
      } catch {}

    } catch (error) {
      // Skip individual IO update errors
    }
  }

  private async handleL2CellUpdated(data: {
    deviceId: number,
    columnId: number,
    value: string | null,
    version: number,
    updatedBy: string | null,
    updatedAt: string
  }): Promise<void> {
    if (!data || typeof data.deviceId !== 'number' || typeof data.columnId !== 'number') return

    const key = `${data.deviceId}-${data.columnId}`
    if (this.recentPushedL2Keys.has(key)) return // Echo — skip

    try {
      // Look up local IDs via CloudId columns
      const localDev = db.prepare('SELECT id FROM L2Devices WHERE CloudId = ?').get(data.deviceId) as { id: number } | undefined
      const localCol = db.prepare('SELECT id FROM L2Columns WHERE CloudId = ?').get(data.columnId) as { id: number } | undefined
      if (!localDev || !localCol) return // Cell not in local DB (different subsystem)

      // Find existing cell value
      const existing = db.prepare('SELECT id, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?').get(localDev.id, localCol.id) as { id: number; Version: number } | undefined

      // Apply only if cloud version is newer (or local doesn't have it)
      if (existing && existing.Version >= data.version) return // Local is newer or equal — skip

      if (existing) {
        db.prepare(`UPDATE L2CellValues SET Value = ?, UpdatedBy = ?, UpdatedAt = ?, Version = ? WHERE id = ?`)
          .run(data.value, data.updatedBy, data.updatedAt, data.version, existing.id)
      } else {
        db.prepare(`INSERT INTO L2CellValues (DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(localDev.id, localCol.id, data.value, data.updatedBy, data.updatedAt, data.version)
      }

      // Recount completed checks for the device
      const completedCount = db.prepare(`SELECT COUNT(*) as cnt FROM L2CellValues cv JOIN L2Columns lc ON cv.ColumnId = lc.id WHERE cv.DeviceId = ? AND lc.IncludeInProgress = 1 AND cv.Value IS NOT NULL AND cv.Value != ''`).get(localDev.id) as { cnt: number } | undefined
      if (completedCount) {
        db.prepare('UPDATE L2Devices SET CompletedChecks = ? WHERE id = ?').run(completedCount.cnt, localDev.id)
      }

      // Broadcast to browser tabs via local WebSocket
      try {
        await fetch(WS_BROADCAST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'L2CellUpdated',
            cloudDeviceId: data.deviceId,
            cloudColumnId: data.columnId,
            localDeviceId: localDev.id,
            localColumnId: localCol.id,
            value: data.value,
            version: data.version,
            updatedBy: data.updatedBy,
            updatedAt: data.updatedAt,
          }),
        })
      } catch {}

      console.log(`[SSE] L2 cell update applied: device ${localDev.id} col ${localCol.id} = "${data.value}" (v${data.version})`)
    } catch (error) {
      // Skip individual L2 cell update errors
    }
  }
}

// Singleton using globalThis
const globalForSse = globalThis as unknown as {
  cloudSseClient: CloudSseClient | undefined
}

export function getCloudSseClient(): CloudSseClient | null {
  return globalForSse.cloudSseClient ?? null
}

export function startCloudSse(config: CloudSseConfig): CloudSseClient {
  if (globalForSse.cloudSseClient) {
    globalForSse.cloudSseClient.updateConfig(config)
    if (!globalForSse.cloudSseClient.isConnected) {
      globalForSse.cloudSseClient.connect()
    }
    return globalForSse.cloudSseClient
  }
  const client = new CloudSseClient(config)
  globalForSse.cloudSseClient = client
  client.connect()
  return client
}

export function stopCloudSse(): void {
  if (globalForSse.cloudSseClient) {
    globalForSse.cloudSseClient.disconnect()
    globalForSse.cloudSseClient = undefined
  }
}
