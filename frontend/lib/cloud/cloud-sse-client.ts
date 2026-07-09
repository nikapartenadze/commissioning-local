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
import { parseDbTimestamp } from '@/lib/cloud/pull-guard'
import { getBroadcastUrl } from '@/lib/broadcast-config'

// SSE connection states
// 'auth-failed' (F15, 2026-07-03 sync audit): the cloud rejected our API key
// (HTTP 401/403). Previously indistinguishable from a transient outage, so a
// bad key produced a silent infinite 5–60s reconnect loop while cloud→field
// propagation was dead. Now surfaced distinctly and retried SLOWLY.
export type SseConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'auth-failed'

export interface CloudSseConfig {
  remoteUrl: string
  apiPassword: string
  subsystemId: string | number
}

const WS_BROADCAST_URL = getBroadcastUrl()

/** A local IO row's fields needed to decide an SSE merge. */
export interface SseLocalIo { Result: string | null; Version: number }

/**
 * Pure decision for which columns an `io_updated` SSE event writes to the local
 * Ios row. Extracted from handleIoUpdated so the merge rules are unit-tested.
 *
 *  - definitions (name/description/order/tagType/version): applied if present.
 *  - result/timestamp/comments: only when cloud version is newer, OR local has
 *    no result yet (last-write-wins — unchanged behaviour).
 *  - punchlistStatus/clarificationNote: applied REGARDLESS of version — the
 *    cloud owns the resolver state and the punchlist PATCH doesn't bump version,
 *    so this is how an admin's Addressed/Clarification lands on a tablet live.
 *
 * When `protectResult` is true (the local row is a deliberate operator clear the
 * cloud value would revert, OR the IO has un-pushed local work queued), the
 * result/timestamp/comments writes are SKIPPED entirely — definition and
 * resolver columns still apply. This ports the destructive-pull clear guard
 * (lib/cloud/pull-guard.ts / delta-sync isProtectedClear) to the live SSE path
 * so the MCM04 "keeps getting reset" loss can't reopen via SSE.
 */
export function computeSseIoUpdate(
  event: any,
  localIo: SseLocalIo,
  protectResult = false,
): { clauses: string[]; params: any[] } {
  const clauses: string[] = []
  const params: any[] = []

  if (event.name !== undefined) { clauses.push('Name = ?'); params.push(event.name) }
  if (event.description !== undefined) { clauses.push('Description = ?'); params.push(event.description) }
  if (event.order !== undefined) { clauses.push('"Order" = ?'); params.push(event.order) }
  if (event.tagType !== undefined) { clauses.push('TagType = ?'); params.push(event.tagType) }
  if (event.version !== undefined) { clauses.push('Version = ?'); params.push(Number(event.version) || 0) }

  // Result/Timestamp/Comments are field-authored. Skip them entirely when the
  // local row is protected (deliberate clear / un-pushed local work) — matches
  // delta-sync's upsertKeepClearStmt, which keeps local result columns while
  // still applying the cloud definition (+ version) fields.
  if (!protectResult) {
    const cloudVersion = Number(event.version) || 0
    const localVersion = localIo.Version ?? 0
    if (cloudVersion > localVersion) {
      if (event.result !== undefined) { clauses.push('Result = ?'); params.push(event.result ?? null) }
      if (event.timestamp !== undefined) { clauses.push('Timestamp = ?'); params.push(event.timestamp ?? null) }
      if (event.comments !== undefined) { clauses.push('Comments = ?'); params.push(event.comments ?? null) }
    } else if (!localIo.Result && event.result) {
      // Local has no result, cloud does — accept regardless of version.
      clauses.push('Result = ?'); params.push(event.result)
      clauses.push('Timestamp = ?'); params.push(event.timestamp ?? null)
      clauses.push('Comments = ?'); params.push(event.comments ?? null)
    }
  }

  // Resolver state — cloud-owned, applied regardless of the version gate (and
  // regardless of protectResult; R3 keeps resolver behaviour exactly as today).
  if (event.punchlistStatus !== undefined) { clauses.push('PunchlistStatus = ?'); params.push(event.punchlistStatus ?? null) }
  if (event.clarificationNote !== undefined) { clauses.push('ClarificationNote = ?'); params.push(event.clarificationNote ?? null) }

  return { clauses, params }
}

/**
 * Decide whether an incoming SSE io-update must NOT overwrite the local Result.
 * Two protected cases, mirroring the destructive-pull guards:
 *   1. An un-pushed local result is queued for this IO (a PendingSyncs row that
 *      is not a resolver-only 'Punchlist Updated' edit) — cloud is stale
 *      relative to local, so keep local until it syncs up.
 *   2. The local latest TestHistories row is a deliberate 'Cleared' that the
 *      cloud value has NOT provably superseded — restoring the cloud result
 *      would revert the operator's clear (the MCM04 reset loop).
 */
function isSseResultProtected(event: any): boolean {
  const ioId = event.id
  if (!ioId) return false
  try {
    const pending = db.prepare(
      `SELECT COUNT(*) AS c FROM PendingSyncs WHERE IoId = ? AND TestResult != 'Punchlist Updated'`,
    ).get(ioId) as { c: number } | undefined
    if (pending && pending.c > 0) return true

    const cloudHasResult = event.result != null && String(event.result).trim() !== ''
    if (!cloudHasResult) return false // cloud restores nothing → nothing to protect
    const last = db.prepare(
      'SELECT Result AS r, Timestamp AS ts FROM TestHistories WHERE IoId = ? ORDER BY id DESC LIMIT 1',
    ).get(ioId) as { r: string | null; ts: string | null } | undefined
    if (!last || last.r !== 'Cleared') return false // not a deliberate clear
    const clearedAt = parseDbTimestamp(last.ts)
    if (!Number.isFinite(clearedAt)) return true // clear with no ts → protect (safe default)
    const cloudTs = Date.parse(event.timestamp ?? '')
    if (Number.isFinite(cloudTs) && cloudTs > clearedAt) return false // real later cloud edit wins
    return true
  } catch {
    // On any DB hiccup, do NOT protect (preserve today's behaviour) — the
    // destructive-pull guards remain the durable second line of defense.
    return false
  }
}

export class CloudSseClient {
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
  private _onSubsystemChangedCallbacks = new Set<(subsystemId: number) => void>()
  // Per-subsystem debounce: a CSV import fires many hints in a burst; collapse
  // them to a single scoped pull per subsystem. Keyed by subsystemId so changes
  // to different MCMs (a central server sees them all on one stream) don't
  // cancel each other.
  private _subsystemChangedTimers = new Map<number, NodeJS.Timeout>()
  private subsystemChangedDebounceMs = 2000

  constructor(config: CloudSseConfig) {
    this.config = config
  }

  /** Register a callback to fire when SSE (re)connects. Returns unsubscribe function. */
  onConnect(callback: () => void): () => void {
    this._onConnectCallbacks.add(callback)
    return () => { this._onConnectCallbacks.delete(callback) }
  }

  /**
   * Register a callback fired (debounced) when the cloud signals that a
   * subsystem's data changed via a `subsystem_changed` hint. The callback
   * receives the changed subsystemId; deciding whether this tool manages that
   * subsystem (and doing the scoped pull) is the caller's job — the cloud
   * broadcasts every subsystem's hint to every authorized subscriber.
   * Returns an unsubscribe function.
   */
  onSubsystemChanged(callback: (subsystemId: number) => void): () => void {
    this._onSubsystemChangedCallbacks.add(callback)
    return () => { this._onSubsystemChangedCallbacks.delete(callback) }
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
    this._subsystemChangedTimers.forEach((timer) => clearTimeout(timer))
    this._subsystemChangedTimers.clear()
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
      }).catch(() => { /* WS broadcast server may not be running */ })
    } catch (err) {
      console.warn('[CloudSSE] Failed to broadcast connection state change:', err)
    }
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

      if (response.status === 401 || response.status === 403) {
        // Auth rejection is NOT a transient outage: hot-loop reconnecting
        // masks the real problem (bad/expired API key or project mismatch)
        // while cloud→field propagation silently stays dead. Surface a
        // distinct state (red in the UI) and retry slowly — the key may be
        // fixed in config, and updateConfig() reconnects immediately anyway.
        console.error(
          `[CloudSSE] AUTH FAILED (HTTP ${response.status}) — cloud rejected the API key for ` +
          `subsystem ${subsystemId}. Check the API password / project assignment. Retrying in 5 min.`,
        )
        this.setConnectionState('auth-failed')
        this.scheduleReconnect(5 * 60_000)
        return
      }

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
        try { cb() } catch (err) {
          console.error('[CloudSSE] Error in onConnect callback:', err)
        }
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
            } catch (err) {
              console.warn('[CloudSSE] Malformed SSE event data:', data.substring(0, 200), err)
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

  private scheduleReconnect(delayOverrideMs?: number): void {
    if (this._intentionalDisconnect) return
    // An auth failure keeps its distinct state (set by the caller); everything
    // else shows the normal reconnecting state.
    if (delayOverrideMs === undefined) this.setConnectionState('reconnecting')
    const delay = delayOverrideMs ?? this.reconnectDelay
    console.log(`[CloudSSE] Reconnecting in ${Math.round(delay / 1000)}s...`)
    this.reconnectTimer = setTimeout(() => {
      this.startStream()
    }, delay)
    // Exponential backoff (only advances the normal path)
    if (delayOverrideMs === undefined) {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay)
    }
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
        this.handleL2CellUpdated(l2Data).catch((err) => {
          console.error('[CloudSSE] L2 cell update error:', err)
        })
        break
      }

      case 'subsystem-changed':
      case 'subsystem_changed': {
        this.handleSubsystemChanged(event.data || event)
        break
      }

      default:
        // Unknown event type — ignore
        break
    }
  }

  /**
   * A `subsystem_changed` hint means the cloud's definition/config data for a
   * subsystem changed (IO add/delete, network/estop/safety import) — a class of
   * change the io_updated result path never carries. We don't ship data here;
   * we debounce, then notify subscribers so they can fetch a scoped delta/pull.
   */
  private handleSubsystemChanged(data: any): void {
    const subsystemId = Number(data?.subsystemId)
    if (!Number.isFinite(subsystemId)) return

    const existing = this._subsystemChangedTimers.get(subsystemId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this._subsystemChangedTimers.delete(subsystemId)
      Array.from(this._onSubsystemChangedCallbacks).forEach((cb) => {
        try { cb(subsystemId) } catch (err) {
          console.error('[CloudSSE] Error in onSubsystemChanged callback:', err)
        }
      })
    }, this.subsystemChangedDebounceMs)

    this._subsystemChangedTimers.set(subsystemId, timer)
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

      // Clear-protection (R3): if a deliberate local clear or un-pushed local
      // work would be reverted by this event, keep the local Result — apply only
      // definition/resolver columns. Same guard the destructive pull uses.
      const protectResult = isSseResultProtected(event)

      // Decide the column writes (pure + unit-tested in
      // __tests__/cloud-sse-io-update.test.ts).
      const { clauses: setClauses, params } = computeSseIoUpdate(event, localIo, protectResult)

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
            // When protecting the local result, tell browsers the LOCAL value
            // (the kept clear/result), not the cloud value we deliberately did
            // not write — otherwise the grid would repaint the reverted value.
            result: protectResult
              ? (localIo.Result || 'Not Tested')
              : (event.result !== undefined ? (event.result || 'Not Tested') : (localIo.Result || 'Not Tested')),
            state: '',
            timestamp: protectResult ? '' : (event.timestamp ?? ''),
            comments: protectResult ? '' : (event.comments ?? ''),
            // Carry resolver state so the grid repaints the Addressed/
            // Clarification badge live without a page refresh.
            punchlistStatus: event.punchlistStatus,
            clarificationNote: event.clarificationNote,
          }),
        }).catch(() => { /* WS broadcast best-effort */ })
      } catch (wsErr) {
        console.warn('[CloudSSE] Failed to broadcast IO update to WS:', wsErr)
      }

    } catch (error) {
      console.error('[CloudSSE] Error handling IO update for id', ioId, ':', error)
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
      const existing = db.prepare('SELECT id, Value FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?').get(localDev.id, localCol.id) as { id: number; Value: string | null } | undefined

      // Same rule as the pull (2026-07-08): a FILLED local cell is field-authored
      // test data and is NEVER overwritten by a cloud event. But a cloud-authored
      // value must still land in a MISSING or EMPTY local cell — this is the belt-
      // tracking handoff (the mechanical fills "Belt Tracked" on the cloud page and
      // the field wizard waits for it). So: insert if missing; fill if empty; keep
      // if filled.
      const incomingFilled = data.value != null && String(data.value).trim() !== ''
      if (!existing) {
        db.prepare(`INSERT INTO L2CellValues (DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(localDev.id, localCol.id, data.value, data.updatedBy, data.updatedAt, data.version)
      } else {
        const localFilled = existing.Value != null && String(existing.Value).trim() !== ''
        if (localFilled) return // never overwrite operator-entered test data
        if (!incomingFilled) return // empty→empty is a no-op
        db.prepare(`UPDATE L2CellValues SET Value = ?, UpdatedBy = ?, UpdatedAt = ?, Version = ? WHERE id = ?`)
          .run(data.value, data.updatedBy, data.updatedAt, data.version, existing.id)
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
      } catch (wsErr) {
        console.warn('[CloudSSE] Failed to broadcast L2 cell update to WS:', wsErr)
      }

      console.log(`[SSE] L2 cell update applied: device ${localDev.id} col ${localCol.id} = "${data.value}" (v${data.version})`)
    } catch (error) {
      console.error('[CloudSSE] Error handling L2 cell update:', error)
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
