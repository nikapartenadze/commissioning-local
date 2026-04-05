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
  ErrorEventMessage
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

export interface WebSocketConnectionOptions {
  url?: string
  reconnectInterval?: number
  maxReconnectAttempts?: number
  /** If false, won't auto-connect. Default: true */
  enabled?: boolean
}

export interface WebSocketConnection {
  isConnected: boolean
  isConfigReloading: boolean
  isTesting: boolean
  isHeartbeatLost: boolean
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
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_WS_URL = 'ws://localhost:3000/ws'
const DEFAULT_RECONNECT_INTERVAL = 3000
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10
const WS_DEBUG = false // Set to true to enable WebSocket logging

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
    reconnectInterval = DEFAULT_RECONNECT_INTERVAL,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    enabled = true
  } = options

  const [isConnected, setIsConnected] = useState(false)
  const [isConfigReloading, setIsConfigReloading] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isHeartbeatLost, setIsHeartbeatLost] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const isManualDisconnectRef = useRef(false)
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastAckRef = useRef<number>(Date.now())
  const serverVersionRef = useRef<string | null>(null)
  const isHeartbeatLostRef = useRef(false)

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

        case 'UpdateIO': {
          const ioMsg = message as UpdateIOMessage
          const update: IOUpdate = {
            Id: ioMsg.id,
            Result: ioMsg.result as IOUpdate['Result'],
            State: ioMsg.state === 'TRUE' ? 'TRUE' : ioMsg.state === 'FALSE' ? 'FALSE' : 'NOT_SET' as any,
            Timestamp: ioMsg.timestamp,
            Comments: ioMsg.comments
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
          const dfMsg = message as { tagName: string; faulted: boolean }
          deviceFaultCallbacksRef.current.forEach((cb) => {
            try {
              cb(dfMsg.tagName, dfMsg.faulted)
            } catch (error) {
              console.error('[PlcWebSocket] Error in device fault callback:', error)
            }
          })
          break
        }

        case 'HeartbeatAck': {
          const ackMsg = message as unknown as { serverVersion: string; timestamp: number }
          lastAckRef.current = Date.now()

          if (isHeartbeatLostRef.current) {
            // Connection restored
            if (serverVersionRef.current && serverVersionRef.current !== ackMsg.serverVersion) {
              // Server version changed — full page reload
              window.location.reload()
            }
            setIsHeartbeatLost(false)
            isHeartbeatLostRef.current = false
          }

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

    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      WS_DEBUG && console.log('[PlcWebSocket] Max reconnect attempts reached')
      const errorEvent: ErrorEvent = {
        source: 'websocket',
        message: 'Failed to reconnect after maximum attempts',
        severity: 'error',
        timestamp: new Date()
      }
      errorCallbacksRef.current.forEach((cb) => {
        try {
          cb(errorEvent)
        } catch {}
      })
      return
    }

    reconnectTimeoutRef.current = setTimeout(() => {
      console.log(
        `[PlcWebSocket] Reconnecting (attempt ${reconnectAttemptsRef.current + 1}/${maxReconnectAttempts})...`
      )
      reconnectAttemptsRef.current++
      connect()
    }, reconnectInterval)
  }, [maxReconnectAttempts, reconnectInterval])

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
        reconnectAttemptsRef.current = 0

        // Notify reconnected callbacks if this was a reconnection
        if (reconnectAttemptsRef.current > 0) {
          reconnectedCallbacksRef.current.forEach((cb) => {
            try {
              cb()
            } catch {}
          })
        }

        // Start heartbeat
        lastAckRef.current = Date.now()
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current)
        }
        heartbeatIntervalRef.current = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'Heartbeat' }))
          }
          // Check if we've missed acks for too long (10s = ~3 missed heartbeats)
          if (Date.now() - lastAckRef.current > 10000) {
            setIsHeartbeatLost(true)
            isHeartbeatLostRef.current = true
          }
        }, 3000)
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
  }
}

// ============================================================================
// Standalone WebSocket Client (non-React)
// ============================================================================

export class PlcWebSocketClient {
  private ws: WebSocket | null = null
  private url: string
  private reconnectInterval: number
  private maxReconnectAttempts: number
  private reconnectAttempts = 0
  private reconnectTimeout: NodeJS.Timeout | null = null
  private isManualDisconnect = false
  private _isConnected = false

  private ioCallbacks: Set<(update: IOUpdate) => void> = new Set()
  private errorCallbacks: Set<(event: ErrorEvent) => void> = new Set()
  private reconnectedCallbacks: Set<() => void> = new Set()

  constructor(options: WebSocketConnectionOptions = {}) {
    this.url = options.url || getDefaultWebSocketUrl()
    this.reconnectInterval = options.reconnectInterval || DEFAULT_RECONNECT_INTERVAL
    this.maxReconnectAttempts = options.maxReconnectAttempts || DEFAULT_MAX_RECONNECT_ATTEMPTS
  }

  get isConnected(): boolean {
    return this._isConnected
  }

  connect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.isManualDisconnect = false

    try {
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        WS_DEBUG && console.log('[PlcWebSocketClient] Connected')
        this._isConnected = true
        const wasReconnect = this.reconnectAttempts > 0
        this.reconnectAttempts = 0

        if (wasReconnect) {
          this.reconnectedCallbacks.forEach((cb) => {
            try {
              cb()
            } catch {}
          })
        }
      }

      this.ws.onmessage = (event) => {
        this.handleMessage(event)
      }

      this.ws.onclose = () => {
        WS_DEBUG && console.log('[PlcWebSocketClient] Disconnected')
        this._isConnected = false
        this.ws = null

        if (!this.isManualDisconnect) {
          this.scheduleReconnect()
        }
      }

      this.ws.onerror = (error) => {
        console.error('[PlcWebSocketClient] Error:', error)
        const errorEvent: ErrorEvent = {
          source: 'websocket',
          message: 'WebSocket connection error',
          severity: 'error',
          timestamp: new Date()
        }
        this.errorCallbacks.forEach((cb) => {
          try {
            cb(errorEvent)
          } catch {}
        })
      }
    } catch (error) {
      console.error('[PlcWebSocketClient] Failed to create WebSocket:', error)
      this.scheduleReconnect()
    }
  }

  disconnect(): void {
    this.isManualDisconnect = true

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this._isConnected = false
    this.reconnectAttempts = 0
  }

  private scheduleReconnect(): void {
    if (this.isManualDisconnect) {
      return
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      WS_DEBUG && console.log('[PlcWebSocketClient] Max reconnect attempts reached')
      return
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++
      console.log(
        `[PlcWebSocketClient] Reconnecting (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
      )
      this.connect()
    }, this.reconnectInterval)
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data) as PlcWebSocketMessage & { type: string }

      if (message.type === 'UpdateState') {
        const stateMsg = message as UpdateStateMessage
        const update: IOUpdate = {
          Id: stateMsg.id,
          Result: 'Not Tested',
          State: stateMsg.state ? 'TRUE' : 'FALSE'
        }
        this.ioCallbacks.forEach((cb) => {
          try {
            cb(update)
          } catch {}
        })
      } else if (message.type === 'UpdateIO') {
        const ioMsg = message as UpdateIOMessage
        const update: IOUpdate = {
          Id: ioMsg.id,
          Result: ioMsg.result as IOUpdate['Result'],
          State: ioMsg.state ? 'TRUE' : 'FALSE',
          Timestamp: ioMsg.timestamp,
          Comments: ioMsg.comments
        }
        this.ioCallbacks.forEach((cb) => {
          try {
            cb(update)
          } catch {}
        })
      }
    } catch (error) {
      console.error('[PlcWebSocketClient] Error parsing message:', error)
    }
  }

  onIOUpdate(callback: (update: IOUpdate) => void): void {
    this.ioCallbacks.add(callback)
  }

  offIOUpdate(callback: (update: IOUpdate) => void): void {
    this.ioCallbacks.delete(callback)
  }

  onError(callback: (event: ErrorEvent) => void): void {
    this.errorCallbacks.add(callback)
  }

  offError(callback: (event: ErrorEvent) => void): void {
    this.errorCallbacks.delete(callback)
  }

  onReconnected(callback: () => void): void {
    this.reconnectedCallbacks.add(callback)
  }

  offReconnected(callback: () => void): void {
    this.reconnectedCallbacks.delete(callback)
  }
}
