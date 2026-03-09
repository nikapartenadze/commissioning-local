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
  ErrorEvent,
  WebSocketConnectionOptions,
  WebSocketConnection
} from './plc/websocket-client'

// Re-export the WebSocket client class
export { PlcWebSocketClient as SignalRService } from './plc/websocket-client'

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
 * @returns SignalRConnection interface
 */
export function useSignalR(hubUrl?: string): SignalRConnection {
  // Convert the old hubUrl format to WebSocket options if provided
  // The old hubUrl was like "http://localhost:5000/hub"
  // The new WebSocket URL should be like "ws://localhost:3001"
  const options: WebSocketConnectionOptions = {}

  if (hubUrl) {
    // Parse the old URL and convert to WebSocket URL
    try {
      const url = new URL(hubUrl)
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      // Use port 3001 for WebSocket server
      options.url = `${wsProtocol}//${url.hostname}:3001`
    } catch {
      // If URL parsing fails, ignore and use default
    }
  }

  const wsConnection = usePlcWebSocket(options)

  // Return with the connection property for backward compatibility
  return {
    ...wsConnection,
    connection: null
  }
}
