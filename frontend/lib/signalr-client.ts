"use client"

/**
 * SignalR Client Compatibility Layer
 *
 * This module re-exports the WebSocket client with SignalR-compatible API.
 * Components can continue importing from '@/lib/signalr-client' without changes.
 */

// Re-export all types from the WebSocket client
export type {
  IOUpdate,
  ConfigurationEvent,
  CommentUpdate,
  NetworkStatusUpdate,
  TagStatusUpdate,
  ErrorEvent,
  FVCellUpdate,
  VfdTagUpdate,
  WebSocketConnectionOptions,
  WebSocketConnection
} from './plc/websocket-client'

// The standalone PlcWebSocketClient class was removed — nobody imported it
// outside the test that defined it. If you need a non-React WebSocket client,
// write a fresh one or hoist the hook into a module-level singleton. Type-only
// re-exports above are still available.

// Import the hook for the alias
import { usePlcWebSocket, WebSocketConnection, WebSocketConnectionOptions } from './plc/websocket-client'

/**
 * SignalR connection interface for backward compatibility.
 * Extends WebSocketConnection with the `connection` property that was in the original SignalR hook.
 */
export interface SignalRConnection extends WebSocketConnection {
  /** @deprecated WebSocket implementation doesn't expose connection object. Always null. */
  connection: null
}

/**
 * useSignalR hook - backward compatible alias for usePlcWebSocket
 *
 * @param hubUrl - Optional WebSocket URL (ignored, uses WebSocket URL configuration)
 * @param subscribeTo - Central-tool: subsystemIds this tab cares about.
 *                     When set, the server filters events server-side so the
 *                     browser only receives broadcasts for these MCMs. Pass
 *                     `['*']` or omit for the legacy receive-everything mode.
 * @returns SignalRConnection interface
 */
export function useSignalR(hubUrl?: string, subscribeTo?: string[]): SignalRConnection {
  // Convert the old hubUrl format to WebSocket options if provided
  // The old hubUrl was like "http://localhost:5000/hub"
  // The new WebSocket URL should be like "ws://localhost:3000/ws"
  const options: WebSocketConnectionOptions = {}

  if (hubUrl) {
    try {
      const url = new URL(hubUrl)
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      options.url = `${wsProtocol}//${url.host}/ws`
    } catch {
      // If URL parsing fails, use default
    }
  }

  if (subscribeTo && subscribeTo.length > 0) {
    options.subscribeTo = subscribeTo
  }

  const wsConnection = usePlcWebSocket(options)

  // Return with the connection property for backward compatibility
  return {
    ...wsConnection,
    connection: null
  }
}
