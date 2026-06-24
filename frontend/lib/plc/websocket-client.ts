"use client"

/**
 * WebSocket Client for Real-time PLC Updates
 * React hook for connecting to the PLC WebSocket server
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import type {
  PlcWebSocketMessage,
  UpdateStateMessage,
  UpdateIOMessage,
  CommentUpdateMessage,
  NetworkStatusChangedMessage,
  ErrorEventMessage,
  L2CellUpdatedMessage,
  VfdTagUpdateMessage,
} from './types'

// ============================================================================
// Types
// ============================================================================

export interface IOUpdate {
  Id: number
  Result: 'Passed' | 'Failed' | 'Cleared' | 'Not Tested'
  State: 'TRUE' | 'FALSE'
  Timestamp?: string
  Comments?: string
  // Failure reason chosen in the Fail dialog. Carried on UpdateIO so other
  // tabs / client laptops see the Party Responsible badge change without a
  // refetch. null on Pass / Clear; absent on state-only updates.
  FailureMode?: string | null
  // Cloud-owned resolver state, forwarded so the grid repaints the
  // Addressed/Clarification badge live without a refetch.
  PunchlistStatus?: string | null
  ClarificationNote?: string | null
}

export interface ConfigurationEvent {
  type: 'reloading' | 'reloaded'
}

export interface CommentUpdate {
  ioId: number
  comments: string
}

export interface NetworkStatusUpdate {
  moduleName: string
  status: string
  reconnecting?: boolean
  errorCount: number
}

export interface TagStatusUpdate {
  totalTags: number
  successfulTags: number
  failedTags: number
  hasErrors: boolean
  connected: boolean
}

export interface ErrorEvent {
  source: 'plc' | 'cloud' | 'tags' | 'system' | 'websocket'
  message: string
  severity: 'error' | 'warning' | 'info'
  timestamp: Date
}

export interface FVCellUpdate {
  cloudDeviceId: number
  cloudColumnId: number
  localDeviceId: number
  localColumnId: number
  value: string | null
  version: number
  updatedBy: string | null
  updatedAt: string
}

/**
 * Payload shape passed to onVfdTagUpdate subscribers. Same as the wire-level
 * VfdTagUpdateMessage minus the type discriminator. Subscribers MUST filter by
 * deviceName — the underlying broadcast goes to every connected client.
 */
export interface VfdTagUpdate {
  deviceName: string
  sts: Record<string, number | boolean | null>
  errors?: Record<string, string>
  ts: number
}

export interface WebSocketConnectionOptions {
  url?: string
  reconnectInterval?: number
  maxReconnectAttempts?: number
  /** If false, won't auto-connect. Default: true */
  enabled?: boolean
  /**
   * Central-tool: limit delivered events to these subsystemIds. The server
   * filters; this client only sees events whose payload subsystemId matches.
   * Pass `['*']` or omit to receive everything (default — backwards compat).
   * Useful when a single browser tab is scoped to one MCM and shouldn't be
   * woken by tag-state events for sibling controllers.
   */
  subscribeTo?: string[]
}

/**
 * Three-tier health for the WS heartbeat. Distinguishes a transient stall
 * (event-loop blocked by a sync DB write, GC pause, slow disk, …) from a
 * genuinely broken connection.
 *
 *   ok   = ack received within HEARTBEAT_SLOW_MS
 *   slow = no ack for >= HEARTBEAT_SLOW_MS but < HEARTBEAT_LOST_MS — surface as a small banner
 *   lost = no ack for >= HEARTBEAT_LOST_MS, OR socket onclose with abnormal code — full modal
 *
 * `isHeartbeatLost` (kept for backward compatibility with existing callers)
 * is now true only in the `lost` state.
 */
export type ConnectionHealth = 'ok' | 'slow' | 'lost'

export interface WebSocketConnection {
  isConnected: boolean
  isConfigReloading: boolean
  isTesting: boolean
  isHeartbeatLost: boolean
  connectionHealth: ConnectionHealth
  /** Seconds since the last ack at the moment the most recent transition logged. Useful for status badges. */
  lastAckAgeSec: number
  connect: () => void
  disconnect: () => void
  onIOUpdate: (callback: (update: IOUpdate) => void) => void
  offIOUpdate: (callback: (update: IOUpdate) => void) => void
  onConfigurationChange: (callback: (event: ConfigurationEvent) => void) => void
  offConfigurationChange: (callback: (event: ConfigurationEvent) => void) => void
  onTestingStateChange: (callback: (isTesting: boolean, isTestingUsers?: string[]) => void) => void
  offTestingStateChange: (callback: (isTesting: boolean, isTestingUsers?: string[]) => void) => void
  onCommentUpdate: (callback: (update: CommentUpdate) => void) => void
  offCommentUpdate: (callback: (update: CommentUpdate) => void) => void
  onNetworkStatusChange: (callback: (update: NetworkStatusUpdate) => void) => void
  offNetworkStatusChange: (callback: (update: NetworkStatusUpdate) => void) => void
  onTagStatusUpdate: (callback: (update: TagStatusUpdate) => void) => void
  offTagStatusUpdate: (callback: (update: TagStatusUpdate) => void) => void
  onError: (callback: (event: ErrorEvent) => void) => void
  offError: (callback: (event: ErrorEvent) => void) => void
  onPlcConnectionChange: (callback: (connected: boolean) => void) => void
  offPlcConnectionChange: (callback: (connected: boolean) => void) => void
  onIOsUpdated: (callback: () => void) => void
  offIOsUpdated: (callback: () => void) => void
  onReconnected: (callback: () => void) => void
  offReconnected: (callback: () => void) => void
  onCloudConnectionChange: (callback: (connected: boolean) => void) => void
  offCloudConnectionChange: (callback: (connected: boolean) => void) => void
  onDeviceFaultChanged: (callback: (tagName: string, faulted: boolean) => void) => void
  offDeviceFaultChanged: (callback: (tagName: string, faulted: boolean) => void) => void
  onFVCellUpdate: (callback: (update: FVCellUpdate) => void) => void
  offFVCellUpdate: (callback: (update: FVCellUpdate) => void) => void
  onVfdTagUpdate: (callback: (update: VfdTagUpdate) => void) => void
  offVfdTagUpdate: (callback: (update: VfdTagUpdate) => void) => void
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_WS_URL = 'ws://localhost:3000/ws'
/**
 * Reconnect uses capped exponential backoff with jitter — no hard attempt cap.
 * The old behavior was 10 fixed-3 s retries (30 s total budget) then permanent
 * give-up, which surfaced as "I left the laptop overnight, now I have to reload."
 * Now: 1 s → 2 s → 4 s → 8 s → 16 s → 30 s cap, retries forever. Combined with
 * the visibility-change + online listeners below, a tab that loses its socket
 * during a long outage springs back automatically the moment connectivity or
 * focus returns.
 */
const RECONNECT_INITIAL_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000
/** Deprecated; retained for option-parameter backwards compatibility, no longer used. */
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10
/** Deprecated; retained for option-parameter backwards compatibility, no longer used. */
const DEFAULT_RECONNECT_INTERVAL = 3000
const WS_DEBUG = false // Set to true to enable WebSocket logging

// Heartbeat thresholds. Sized so that a single slow `better-sqlite3` write
// or GC pause (typical: a few hundred ms; pathological: a few seconds)
// never trips the lost state.
const HEARTBEAT_INTERVAL_MS = 3000
const HEARTBEAT_SLOW_MS = 7000    // 'slow' — transient banner (~2 missed beats)
const HEARTBEAT_LOST_MS = 12000   // 'lost' — full-screen blocking overlay (~4 missed beats)

function getDefaultWebSocketUrl(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_WS_URL
  }
  // Use the same host as the page but with WebSocket protocol and /ws path
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

// ============================================================================
// React Hook
// ============================================================================

export function usePlcWebSocket(options: WebSocketConnectionOptions = {}): WebSocketConnection {
  const {
    url = getDefaultWebSocketUrl(),
    // reconnectInterval is now the BASE delay for exponential backoff (default
    // is RECONNECT_INITIAL_DELAY_MS used by the schedule function itself). The
    // option is kept for backwards-compat; callers can override the base but
    // the cap (RECONNECT_MAX_DELAY_MS) and the no-cap-on-attempts behaviour
    // win out. Marked unused by the linter intentionally.
    reconnectInterval: _reconnectInterval = DEFAULT_RECONNECT_INTERVAL,
    // No hard cap by default. Pass an explicit number to opt back in.
    maxReconnectAttempts = Infinity,
    enabled = true,
    subscribeTo,
  } = options
  void _reconnectInterval
  void enabled

  // Stable ref so reconnect handlers see the latest subscription set without
  // forcing the connect effect to re-run on every render.
  const subscribeToRef = useRef<string[] | undefined>(subscribeTo)
  useEffect(() => { subscribeToRef.current = subscribeTo }, [subscribeTo])

  const [isConnected, setIsConnected] = useState(false)
  const [isConfigReloading, setIsConfigReloading] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isHeartbeatLost, setIsHeartbeatLost] = useState(false)
  const [connectionHealth, setConnectionHealth] = useState<ConnectionHealth>('ok')
  const [lastAckAgeSec, setLastAckAgeSec] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const isManualDisconnectRef = useRef(false)
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastAckRef = useRef<number>(Date.now())
  const serverVersionRef = useRef<string | null>(null)
  const isHeartbeatLostRef = useRef(false)
  const connectionHealthRef = useRef<ConnectionHealth>('ok')

  /**
   * Single funnel for connection-health transitions. Updates both the ref
   * (read by tick callbacks without re-rendering) and React state (read by
   * UI). Logs each transition with the lastAck age so future incidents
   * leave a breadcrumb in the browser console.
   */
  const updateHealth = useCallback((next: ConnectionHealth) => {
    if (connectionHealthRef.current === next) return
    const prev = connectionHealthRef.current
    const ageMs = Date.now() - lastAckRef.current
    connectionHealthRef.current = next
    setConnectionHealth(next)
    setLastAckAgeSec(Math.round(ageMs / 1000))
    setIsHeartbeatLost(next === 'lost')
    isHeartbeatLostRef.current = next === 'lost'
    // Always log — heartbeat issues are exactly the kind of thing we want
    // a trail for, even when WS_DEBUG is off.
    const msg = `[PlcWebSocket] connection health: ${prev} → ${next} (lastAck ${Math.round(ageMs / 1000)}s ago)`
    if (next === 'lost') console.error(msg)
    else if (next === 'slow') console.warn(msg)
    else console.info(msg)
  }, [])

  // Callback refs
  const ioCallbacksRef = useRef<Set<(update: IOUpdate) => void>>(new Set())
  const configCallbacksRef = useRef<Set<(event: ConfigurationEvent) => void>>(new Set())
  const testingCallbacksRef = useRef<Set<(isTesting: boolean, isTestingUsers?: string[]) => void>>(new Set())
  const commentCallbacksRef = useRef<Set<(update: CommentUpdate) => void>>(new Set())
  const networkStatusCallbacksRef = useRef<Set<(update: NetworkStatusUpdate) => void>>(new Set())
  const errorCallbacksRef = useRef<Set<(event: ErrorEvent) => void>>(new Set())
  const plcConnectionCallbacksRef = useRef<Set<(connected: boolean) => void>>(new Set())
  const iosUpdatedCallbacksRef = useRef<Set<() => void>>(new Set())
  const tagStatusCallbacksRef = useRef<Set<(update: TagStatusUpdate) => void>>(new Set())
  const reconnectedCallbacksRef = useRef<Set<() => void>>(new Set())
  const cloudConnectionCallbacksRef = useRef<Set<(connected: boolean) => void>>(new Set())
  const deviceFaultCallbacksRef = useRef<Set<(tagName: string, faulted: boolean) => void>>(new Set())
  const fvCellCallbacksRef = useRef<Set<(update: FVCellUpdate) => void>>(new Set())
  const vfdTagUpdateCallbacksRef = useRef<Set<(update: VfdTagUpdate) => void>>(new Set())

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data) as PlcWebSocketMessage & { type: string }

      if (process.env.NODE_ENV === 'development') {
        WS_DEBUG && console.log('[PlcWebSocket] Received:', message.type)
      }

      switch (message.type as string) {
        case 'UpdateState': {
          const stateMsg = message as UpdateStateMessage
          const update: IOUpdate = {
            Id: stateMsg.id,
            Result: 'Not Tested',
            State: stateMsg.state ? 'TRUE' : 'FALSE',
            Timestamp: undefined,
            Comments: undefined
          }
          ioCallbacksRef.current.forEach((cb) => {
            try {
              cb(update)
            } catch (error) {
              console.error('[PlcWebSocket] Error in IO callback:', error)
            }
          })
          break
        }

        // Sent by the server right after the WebSocket opens — bulk
        // snapshot of every currently-known tag state. We fan it out as
        // individual UpdateState-shaped events so the existing per-IO
        // subscribers (in commissioning page.tsx, etc.) update their
        // state bubbles without needing any new code path. See the
        // server-side comment in server-express.ts for the why.
        case 'TagSnapshot': {
          const snapshot = message as unknown as { states: Array<{ id: number; state: boolean }> }
          if (Array.isArray(snapshot.states)) {
            for (const s of snapshot.states) {
              const update: IOUpdate = {
                Id: s.id,
                Result: 'Not Tested',
                State: s.state ? 'TRUE' : 'FALSE',
                Timestamp: undefined,
                Comments: undefined,
              }
              ioCallbacksRef.current.forEach((cb) => {
                try { cb(update) } catch (error) {
                  console.error('[PlcWebSocket] Error in IO callback (snapshot):', error)
                }
              })
            }
            if (process.env.NODE_ENV === 'development') {
              WS_DEBUG && console.log(`[PlcWebSocket] Applied TagSnapshot — ${snapshot.states.length} states`)
            }
          }
          break
        }

        case 'UpdateIO': {
          const ioMsg = message as UpdateIOMessage
          const update: IOUpdate = {
            Id: ioMsg.id,
            Result: ioMsg.result as IOUpdate['Result'],
            State: ioMsg.state === 'TRUE' ? 'TRUE' : ioMsg.state === 'FALSE' ? 'FALSE' : 'NOT_SET' as any,
            Timestamp: ioMsg.timestamp,
            Comments: ioMsg.comments,
            // Forward failureMode so cross-tab grids update the Party
            // Responsible column in lockstep with Result/Comments. Server
            // omits the field on state-only events.
            FailureMode: ioMsg.failureMode,
            PunchlistStatus: ioMsg.punchlistStatus,
            ClarificationNote: ioMsg.clarificationNote,
          }
          ioCallbacksRef.current.forEach((cb) => {
            try {
              cb(update)
            } catch (error) {
              console.error('[PlcWebSocket] Error in IO callback:', error)
            }
          })
          break
        }

        case 'ConfigReload': {
          const configMsg = message as import('./types').ConfigReloadMessage
          setIsConfigReloading(configMsg.status === 'reloading')
          const event: ConfigurationEvent = { type: configMsg.status }
          configCallbacksRef.current.forEach((cb) => {
            try {
              cb(event)
            } catch (error) {
              console.error('[PlcWebSocket] Error in config callback:', error)
            }
          })
          break
        }

        case 'TestingStateChanged': {
          const testingMsg = message as import('./types').TestingStateChangedMessage
          setIsTesting(testingMsg.isTesting)
          testingCallbacksRef.current.forEach((cb) => {
            try {
              cb(testingMsg.isTesting, testingMsg.isTestingUsers)
            } catch (error) {
              console.error('[PlcWebSocket] Error in testing callback:', error)
            }
          })
          break
        }

        case 'PlcConnectionChanged': {
          const connected = (message as any).connected as boolean
          plcConnectionCallbacksRef.current.forEach((cb) => {
            try {
              cb(connected)
            } catch (error) {
              console.error('[PlcWebSocket] Error in plc connection callback:', error)
            }
          })
          break
        }

        case 'IOsUpdated': {
          iosUpdatedCallbacksRef.current.forEach((cb) => {
            try { cb() } catch (error) {
              console.error('[PlcWebSocket] Error in IOsUpdated callback:', error)
            }
          })
          break
        }

        case 'CloudConnectionChanged': {
          const connected = (message as any).connected === true
          cloudConnectionCallbacksRef.current.forEach((cb) => {
            try { cb(connected) } catch (error) {
              console.error('[PlcWebSocket] Error in CloudConnection callback:', error)
            }
          })
          break
        }

        case 'CommentUpdate': {
          const commentMsg = message as CommentUpdateMessage
          const update: CommentUpdate = {
            ioId: commentMsg.ioId,
            comments: commentMsg.comments
          }
          commentCallbacksRef.current.forEach((cb) => {
            try {
              cb(update)
            } catch (error) {
              console.error('[PlcWebSocket] Error in comment callback:', error)
            }
          })
          break
        }

        case 'NetworkStatusChanged': {
          const netMsg = message as NetworkStatusChangedMessage
          const isOnline = netMsg.status === 'connected' || netMsg.isOnline === true
          const update: NetworkStatusUpdate = {
            moduleName: netMsg.moduleName,
            status: netMsg.reconnecting ? 'reconnecting' : isOnline ? 'online' : 'offline',
            reconnecting: netMsg.reconnecting ?? false,
            errorCount: netMsg.errorCount ?? netMsg.affectedTags?.length ?? 0,
          }
          networkStatusCallbacksRef.current.forEach((cb) => {
            try {
              cb(update)
            } catch (error) {
              console.error('[PlcWebSocket] Error in network status callback:', error)
            }
          })
          break
        }

        case 'ErrorEvent': {
          const errMsg = message as ErrorEventMessage & { source?: string; timestamp?: string }
          const event: ErrorEvent = {
            source: (errMsg.source as ErrorEvent['source']) ?? 'system',
            message: errMsg.message,
            severity: errMsg.severity as ErrorEvent['severity'],
            timestamp: errMsg.timestamp ? new Date(errMsg.timestamp) : new Date()
          }
          errorCallbacksRef.current.forEach((cb) => {
            try {
              cb(event)
            } catch (error) {
              console.error('[PlcWebSocket] Error in error callback:', error)
            }
          })
          break
        }

        case 'TagStatusUpdate': {
          const tsMsg = message as import('./types').TagStatusUpdateMessage
          const update: TagStatusUpdate = {
            totalTags: tsMsg.totalTags,
            successfulTags: tsMsg.successfulTags,
            failedTags: tsMsg.failedTags,
            hasErrors: tsMsg.hasErrors,
            connected: tsMsg.connected,
          }
          tagStatusCallbacksRef.current.forEach((cb) => {
            try {
              cb(update)
            } catch (error) {
              console.error('[PlcWebSocket] Error in tag status callback:', error)
            }
          })
          break
        }

        case 'DeviceFaultChanged': {
          const dfMsg = message as unknown as { tagName: string; faulted: boolean }
          deviceFaultCallbacksRef.current.forEach((cb) => {
            try {
              cb(dfMsg.tagName, dfMsg.faulted)
            } catch (error) {
              console.error('[PlcWebSocket] Error in device fault callback:', error)
            }
          })
          break
        }

        case 'L2CellUpdated': {
          const l2Msg = message as L2CellUpdatedMessage
          const update: FVCellUpdate = {
            cloudDeviceId: l2Msg.cloudDeviceId,
            cloudColumnId: l2Msg.cloudColumnId,
            localDeviceId: l2Msg.localDeviceId,
            localColumnId: l2Msg.localColumnId,
            value: l2Msg.value,
            version: l2Msg.version,
            updatedBy: l2Msg.updatedBy,
            updatedAt: l2Msg.updatedAt,
          }
          fvCellCallbacksRef.current.forEach((cb) => {
            try {
              cb(update)
            } catch (error) {
              console.error('[PlcWebSocket] Error in FV cell callback:', error)
            }
          })
          break
        }

        case 'VfdTagUpdate': {
          const vfdMsg = message as VfdTagUpdateMessage
          const update: VfdTagUpdate = {
            deviceName: vfdMsg.deviceName,
            sts: vfdMsg.sts,
            errors: vfdMsg.errors,
            ts: vfdMsg.ts,
          }
          vfdTagUpdateCallbacksRef.current.forEach((cb) => {
            try {
              cb(update)
            } catch (error) {
              console.error('[PlcWebSocket] Error in VfdTagUpdate callback:', error)
            }
          })
          break
        }

        case 'HeartbeatAck': {
          const ackMsg = message as unknown as { serverVersion: string; timestamp: number }
          lastAckRef.current = Date.now()

          // Server version changed across a 'lost' gap → assume the binary
          // was upgraded, full page reload picks up new client assets.
          if (isHeartbeatLostRef.current
            && serverVersionRef.current
            && serverVersionRef.current !== ackMsg.serverVersion) {
            window.location.reload()
          }

          // Any ack puts us back in the green state, including transitions
          // through 'slow'. updateHealth no-ops if already 'ok'.
          updateHealth('ok')

          if (!serverVersionRef.current) {
            serverVersionRef.current = ackMsg.serverVersion
          }
          break
        }
      }
    } catch (error) {
      console.error('[PlcWebSocket] Error parsing message:', error)
    }
  }, [])

  const scheduleReconnect = useCallback(() => {
    if (isManualDisconnectRef.current) {
      return
    }

    // Capped exponential backoff with jitter. No hard attempt cap — the
    // socket keeps trying forever (visibility / online listeners reset the
    // attempt counter when the user returns or network restores). Jitter
    // avoids thundering-herd reconnects if a server restart drops a roomful
    // of tablets simultaneously.
    const attempts = reconnectAttemptsRef.current
    const baseDelay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(2, attempts),
      RECONNECT_MAX_DELAY_MS,
    )
    const jitter = 0.85 + Math.random() * 0.3 // ±15%
    const delay = Math.floor(baseDelay * jitter)

    // Honour an explicit caller-supplied attempt cap if one was passed
    // through `options.maxReconnectAttempts`. Default is Infinity (no cap).
    if (Number.isFinite(maxReconnectAttempts) && reconnectAttemptsRef.current >= maxReconnectAttempts) {
      WS_DEBUG && console.log('[PlcWebSocket] Caller-supplied max reconnect attempts reached')
      return
    }

    reconnectTimeoutRef.current = setTimeout(() => {
      console.log(`[PlcWebSocket] Reconnecting (attempt ${reconnectAttemptsRef.current + 1}, delay ${delay}ms)...`)
      reconnectAttemptsRef.current++
      connect()
    }, delay)
  }, [maxReconnectAttempts])

  const connect = useCallback(() => {
    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    isManualDisconnectRef.current = false

    try {
      WS_DEBUG && console.log('[PlcWebSocket] Connecting to:', url)
      const ws = new WebSocket(url)

      ws.onopen = () => {
        WS_DEBUG && console.log('[PlcWebSocket] Connected to:', url)
        setIsConnected(true)

        // Central-tool: opt into per-MCM filtering as soon as the socket is
        // ready. Sending '*' or omitting subscribeTo means "receive all
        // events" — that's the legacy default and what every existing UI
        // that doesn't yet know about MCMs continues to get.
        const subs = subscribeToRef.current
        if (subs && subs.length > 0) {
          try {
            ws.send(JSON.stringify({ type: 'Subscribe', subsystemIds: subs }))
            WS_DEBUG && console.log('[PlcWebSocket] Subscribed to subsystemIds:', subs)
          } catch (err) {
            console.warn('[PlcWebSocket] Subscribe send failed:', err)
          }
        }

        // Capture the reconnect-attempt count BEFORE resetting it. The old
        // code reset to 0 first and then checked `> 0`, so the conditional
        // was always false and onReconnected listeners never fired. Side
        // effect: the commissioning page's loadIos() trigger on reconnect
        // never ran, so an IO grid that briefly lost its WS would sit on
        // stale state until a full page reload. Standalone PlcWebSocketClient
        // class below this hook already does it correctly — match its order.
        const wasReconnect = reconnectAttemptsRef.current > 0
        reconnectAttemptsRef.current = 0

        if (wasReconnect) {
          console.log('[PlcWebSocket] Reconnected — firing onReconnected listeners')
          reconnectedCallbacksRef.current.forEach((cb) => {
            try {
              cb()
            } catch {}
          })
        }

        // Start heartbeat — reset the timestamp BEFORE the first tick so a
        // stale `lastAckRef` left over from a previous connection doesn't
        // immediately trip the slow/lost thresholds. Also reset the health
        // state, so a modal that was visible at disconnect drops as soon
        // as the WS comes back (without waiting for the first ack).
        lastAckRef.current = Date.now()
        updateHealth('ok')
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current)
        }
        heartbeatIntervalRef.current = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'Heartbeat' }))
          }
          const age = Date.now() - lastAckRef.current
          if (age > HEARTBEAT_LOST_MS) {
            updateHealth('lost')
          } else if (age > HEARTBEAT_SLOW_MS) {
            updateHealth('slow')
          }
        }, HEARTBEAT_INTERVAL_MS)
      }

      ws.onmessage = handleMessage

      ws.onclose = (event) => {
        WS_DEBUG && console.log('[PlcWebSocket] Disconnected:', event.code, event.reason)
        setIsConnected(false)
        wsRef.current = null

        // Stop heartbeat
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current)
          heartbeatIntervalRef.current = null
        }

        // Code 1005 = No Status Received (normal during page navigation)
        // Code 1000 = Normal closure
        // Don't show errors for these normal close codes
        const isNormalClose = event.code === 1005 || event.code === 1000

        if (!isManualDisconnectRef.current && !isNormalClose) {
          // The socket actually died — promote to 'lost' immediately so the
          // modal shows without waiting for the heartbeat threshold.
          updateHealth('lost')
          const errorEvent: ErrorEvent = {
            source: 'websocket',
            message: 'Lost connection to server',
            severity: 'error',
            timestamp: new Date()
          }
          errorCallbacksRef.current.forEach((cb) => {
            try {
              cb(errorEvent)
            } catch {}
          })
        }

        // Still reconnect unless it was manual
        if (!isManualDisconnectRef.current) {
          scheduleReconnect()
        }
      }

      ws.onerror = (error) => {
        console.error('[PlcWebSocket] Error:', error)
        const errorEvent: ErrorEvent = {
          source: 'websocket',
          message: 'WebSocket connection error',
          severity: 'error',
          timestamp: new Date()
        }
        errorCallbacksRef.current.forEach((cb) => {
          try {
            cb(errorEvent)
          } catch {}
        })
      }

      wsRef.current = ws
    } catch (error) {
      console.error('[PlcWebSocket] Failed to create WebSocket:', error)
      scheduleReconnect()
    }
  }, [url, handleMessage, scheduleReconnect])

  const disconnect = useCallback(() => {
    isManualDisconnectRef.current = true

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current)
      heartbeatIntervalRef.current = null
    }

    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    setIsConnected(false)
    setIsHeartbeatLost(false)
    isHeartbeatLostRef.current = false
    reconnectAttemptsRef.current = 0
    WS_DEBUG && console.log('[PlcWebSocket] Manually disconnected')
  }, [])

  // Callback registration functions
  const onIOUpdate = useCallback((callback: (update: IOUpdate) => void) => {
    ioCallbacksRef.current.add(callback)
  }, [])

  const offIOUpdate = useCallback((callback: (update: IOUpdate) => void) => {
    ioCallbacksRef.current.delete(callback)
  }, [])

  const onConfigurationChange = useCallback((callback: (event: ConfigurationEvent) => void) => {
    configCallbacksRef.current.add(callback)
  }, [])

  const offConfigurationChange = useCallback((callback: (event: ConfigurationEvent) => void) => {
    configCallbacksRef.current.delete(callback)
  }, [])

  const onTestingStateChange = useCallback((callback: (isTesting: boolean, isTestingUsers?: string[]) => void) => {
    testingCallbacksRef.current.add(callback)
  }, [])

  const offTestingStateChange = useCallback((callback: (isTesting: boolean, isTestingUsers?: string[]) => void) => {
    testingCallbacksRef.current.delete(callback)
  }, [])

  const onCommentUpdate = useCallback((callback: (update: CommentUpdate) => void) => {
    commentCallbacksRef.current.add(callback)
  }, [])

  const offCommentUpdate = useCallback((callback: (update: CommentUpdate) => void) => {
    commentCallbacksRef.current.delete(callback)
  }, [])

  const onNetworkStatusChange = useCallback((callback: (update: NetworkStatusUpdate) => void) => {
    networkStatusCallbacksRef.current.add(callback)
  }, [])

  const offNetworkStatusChange = useCallback((callback: (update: NetworkStatusUpdate) => void) => {
    networkStatusCallbacksRef.current.delete(callback)
  }, [])

  const onTagStatusUpdate = useCallback((callback: (update: TagStatusUpdate) => void) => {
    tagStatusCallbacksRef.current.add(callback)
  }, [])

  const offTagStatusUpdate = useCallback((callback: (update: TagStatusUpdate) => void) => {
    tagStatusCallbacksRef.current.delete(callback)
  }, [])

  const onDeviceFaultChanged = useCallback((callback: (tagName: string, faulted: boolean) => void) => {
    deviceFaultCallbacksRef.current.add(callback)
  }, [])

  const offDeviceFaultChanged = useCallback((callback: (tagName: string, faulted: boolean) => void) => {
    deviceFaultCallbacksRef.current.delete(callback)
  }, [])

  const onFVCellUpdate = useCallback((callback: (update: FVCellUpdate) => void) => {
    fvCellCallbacksRef.current.add(callback)
  }, [])

  const offFVCellUpdate = useCallback((callback: (update: FVCellUpdate) => void) => {
    fvCellCallbacksRef.current.delete(callback)
  }, [])

  const onVfdTagUpdate = useCallback((callback: (update: VfdTagUpdate) => void) => {
    vfdTagUpdateCallbacksRef.current.add(callback)
  }, [])

  const offVfdTagUpdate = useCallback((callback: (update: VfdTagUpdate) => void) => {
    vfdTagUpdateCallbacksRef.current.delete(callback)
  }, [])

  const onError = useCallback((callback: (event: ErrorEvent) => void) => {
    errorCallbacksRef.current.add(callback)
  }, [])

  const offError = useCallback((callback: (event: ErrorEvent) => void) => {
    errorCallbacksRef.current.delete(callback)
  }, [])

  const onPlcConnectionChange = useCallback((callback: (connected: boolean) => void) => {
    plcConnectionCallbacksRef.current.add(callback)
  }, [])

  const offPlcConnectionChange = useCallback((callback: (connected: boolean) => void) => {
    plcConnectionCallbacksRef.current.delete(callback)
  }, [])

  const onIOsUpdated = useCallback((callback: () => void) => {
    iosUpdatedCallbacksRef.current.add(callback)
  }, [])

  const offIOsUpdated = useCallback((callback: () => void) => {
    iosUpdatedCallbacksRef.current.delete(callback)
  }, [])

  const onReconnected = useCallback((callback: () => void) => {
    reconnectedCallbacksRef.current.add(callback)
  }, [])

  const offReconnected = useCallback((callback: () => void) => {
    reconnectedCallbacksRef.current.delete(callback)
  }, [])

  const onCloudConnectionChange = useCallback((callback: (connected: boolean) => void) => {
    cloudConnectionCallbacksRef.current.add(callback)
  }, [])

  const offCloudConnectionChange = useCallback((callback: (connected: boolean) => void) => {
    cloudConnectionCallbacksRef.current.delete(callback)
  }, [])

  // Force-reconnect triggers — run when state hints the socket is wrong but
  // backoff would otherwise keep waiting. Common scenarios this fixes:
  //   1. Tablet sleeps overnight. WS times out, backoff caps at 30 s and keeps
  //      retrying — but the OS may have paused timers. When the user wakes
  //      the tablet, `visibilitychange` fires and we reconnect immediately
  //      with a fresh attempt budget instead of waiting up to 30 s.
  //   2. Wi-Fi blip / VPN reconnect. `navigator.onLine` flips false→true
  //      well before our heartbeat would notice, so jumping on `online` lets
  //      us re-establish state ahead of the user's next click.
  // Both reset reconnectAttemptsRef so the next attempt starts at the 1 s
  // base delay (not the 30 s cap we may have backed off to).
  const forceReconnectNow = useCallback((reason: string) => {
    if (isManualDisconnectRef.current) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    console.log(`[PlcWebSocket] Force-reconnect: ${reason}`)
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
    reconnectAttemptsRef.current = 0
    connect()
  }, [connect])

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') forceReconnectNow('tab visible')
    }
    const onOnline = () => forceReconnectNow('navigator.onLine = true')
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', onOnline)
    }
  }, [forceReconnectNow])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect()
    }
  }, [disconnect])

  return {
    isConnected,
    isConfigReloading,
    isTesting,
    isHeartbeatLost,
    connectionHealth,
    lastAckAgeSec,
    connect,
    disconnect,
    onIOUpdate,
    offIOUpdate,
    onConfigurationChange,
    offConfigurationChange,
    onTestingStateChange,
    offTestingStateChange,
    onCommentUpdate,
    offCommentUpdate,
    onNetworkStatusChange,
    offNetworkStatusChange,
    onTagStatusUpdate,
    offTagStatusUpdate,
    onError,
    offError,
    onPlcConnectionChange,
    offPlcConnectionChange,
    onIOsUpdated,
    offIOsUpdated,
    onReconnected,
    offReconnected,
    onCloudConnectionChange,
    offCloudConnectionChange,
    onDeviceFaultChanged,
    offDeviceFaultChanged,
    onFVCellUpdate,
    offFVCellUpdate,
    onVfdTagUpdate,
    offVfdTagUpdate,
  }
}

