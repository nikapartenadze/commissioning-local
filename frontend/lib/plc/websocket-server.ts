/**
 * WebSocket Server for Real-time PLC Updates
 * Replaces SignalR for broadcasting tag state updates to connected clients
 */

import { WebSocketServer, WebSocket } from 'ws'

// ============================================================================
// Message Types
// ============================================================================

export type MessageType =
  | 'UpdateState'
  | 'UpdateIO'
  | 'ConfigurationReloading'
  | 'ConfigurationReloaded'
  | 'TestingStateChanged'
  | 'CommentUpdate'
  | 'NetworkStatusChanged'
  | 'ErrorEvent'

export interface UpdateStateMessage {
  type: 'UpdateState'
  id: number
  state: boolean
}

export interface UpdateIOMessage {
  type: 'UpdateIO'
  id: number
  result: 'Passed' | 'Failed' | 'Cleared' | 'Not Tested'
  state: boolean
  timestamp: string
  comments: string
}

export interface ConfigurationReloadingMessage {
  type: 'ConfigurationReloading'
}

export interface ConfigurationReloadedMessage {
  type: 'ConfigurationReloaded'
}

export interface TestingStateChangedMessage {
  type: 'TestingStateChanged'
  isTesting: boolean
}

export interface CommentUpdateMessage {
  type: 'CommentUpdate'
  ioId: number
  comments: string
}

export interface NetworkStatusChangedMessage {
  type: 'NetworkStatusChanged'
  moduleName: string
  status: string
  errorCount: number
}

export interface ErrorEventMessage {
  type: 'ErrorEvent'
  source: 'plc' | 'cloud' | 'tags' | 'system' | 'websocket'
  message: string
  severity: 'error' | 'warning' | 'info'
  timestamp: string
}

export type PlcWebSocketMessage =
  | UpdateStateMessage
  | UpdateIOMessage
  | ConfigurationReloadingMessage
  | ConfigurationReloadedMessage
  | TestingStateChangedMessage
  | CommentUpdateMessage
  | NetworkStatusChangedMessage
  | ErrorEventMessage

// ============================================================================
// WebSocket Server
// ============================================================================

export interface PlcWebSocketServerOptions {
  port: number
  heartbeatInterval?: number
}

export class PlcWebSocketServer {
  private wss: WebSocketServer
  private clients: Set<WebSocket> = new Set()
  private heartbeatInterval: NodeJS.Timeout | null = null
  private isRunning = false
  private readonly options: PlcWebSocketServerOptions

  constructor(options: PlcWebSocketServerOptions) {
    this.options = {
      heartbeatInterval: 30000,
      ...options
    }

    this.wss = new WebSocketServer({ port: this.options.port })
    this.setupWebSocketServer()
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('[PlcWebSocket] New client connected')
      this.clients.add(ws)

      // Mark connection as alive for heartbeat
      ;(ws as any).isAlive = true

      ws.on('pong', () => {
        ;(ws as any).isAlive = true
      })

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString())
          this.handleClientMessage(ws, message)
        } catch (error) {
          console.error('[PlcWebSocket] Error parsing message:', error)
        }
      })

      ws.on('close', () => {
        console.log('[PlcWebSocket] Client disconnected')
        this.clients.delete(ws)
      })

      ws.on('error', (error) => {
        console.error('[PlcWebSocket] Client error:', error)
        this.clients.delete(ws)
      })
    })

    // Start heartbeat to detect dead connections
    this.startHeartbeat()
    this.isRunning = true

    console.log(`[PlcWebSocket] Server listening on port ${this.options.port}`)
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if ((ws as any).isAlive === false) {
          console.log('[PlcWebSocket] Terminating dead connection')
          this.clients.delete(ws)
          return ws.terminate()
        }

        ;(ws as any).isAlive = false
        ws.ping()
      })
    }, this.options.heartbeatInterval)
  }

  private handleClientMessage(ws: WebSocket, message: any): void {
    // Handle any client-to-server messages if needed
    // For now, the server primarily broadcasts to clients
    console.log('[PlcWebSocket] Received client message:', message.type)
  }

  /**
   * Broadcast a tag state update to all connected clients
   */
  public broadcastStateUpdate(id: number, state: boolean): void {
    const message: UpdateStateMessage = {
      type: 'UpdateState',
      id,
      state
    }
    this.broadcast(message)
  }

  /**
   * Broadcast an IO test result update to all connected clients
   */
  public broadcastIOUpdate(
    id: number,
    result: UpdateIOMessage['result'],
    state: boolean,
    timestamp: string,
    comments: string
  ): void {
    const message: UpdateIOMessage = {
      type: 'UpdateIO',
      id,
      result,
      state,
      timestamp,
      comments
    }
    this.broadcast(message)
  }

  /**
   * Broadcast configuration reloading event
   */
  public broadcastConfigurationReloading(): void {
    const message: ConfigurationReloadingMessage = {
      type: 'ConfigurationReloading'
    }
    this.broadcast(message)
  }

  /**
   * Broadcast configuration reloaded event
   */
  public broadcastConfigurationReloaded(): void {
    const message: ConfigurationReloadedMessage = {
      type: 'ConfigurationReloaded'
    }
    this.broadcast(message)
  }

  /**
   * Broadcast testing state change
   */
  public broadcastTestingStateChanged(isTesting: boolean): void {
    const message: TestingStateChangedMessage = {
      type: 'TestingStateChanged',
      isTesting
    }
    this.broadcast(message)
  }

  /**
   * Broadcast comment update
   */
  public broadcastCommentUpdate(ioId: number, comments: string): void {
    const message: CommentUpdateMessage = {
      type: 'CommentUpdate',
      ioId,
      comments
    }
    this.broadcast(message)
  }

  /**
   * Broadcast network status change
   */
  public broadcastNetworkStatusChanged(
    moduleName: string,
    status: string,
    errorCount: number
  ): void {
    const message: NetworkStatusChangedMessage = {
      type: 'NetworkStatusChanged',
      moduleName,
      status,
      errorCount
    }
    this.broadcast(message)
  }

  /**
   * Broadcast error event
   */
  public broadcastErrorEvent(
    source: ErrorEventMessage['source'],
    message: string,
    severity: ErrorEventMessage['severity']
  ): void {
    const errorMessage: ErrorEventMessage = {
      type: 'ErrorEvent',
      source,
      message,
      severity,
      timestamp: new Date().toISOString()
    }
    this.broadcast(errorMessage)
  }

  /**
   * Broadcast a message to all connected clients
   */
  private broadcast(message: PlcWebSocketMessage): void {
    const data = JSON.stringify(message)
    let sentCount = 0

    this.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
        sentCount++
      }
    })

    if (process.env.NODE_ENV === 'development' && sentCount > 0) {
      console.log(`[PlcWebSocket] Broadcast ${message.type} to ${sentCount} clients`)
    }
  }

  /**
   * Get the number of connected clients
   */
  public getClientCount(): number {
    return this.clients.size
  }

  /**
   * Check if the server is running
   */
  public isServerRunning(): boolean {
    return this.isRunning
  }

  /**
   * Stop the WebSocket server
   */
  public stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    this.clients.forEach((ws) => {
      ws.close()
    })
    this.clients.clear()

    this.wss.close()
    this.isRunning = false

    console.log('[PlcWebSocket] Server stopped')
  }
}

// ============================================================================
// Global Instance Management
// ============================================================================

let serverInstance: PlcWebSocketServer | null = null

/**
 * Start the PLC WebSocket server (singleton)
 */
export function startPlcWebSocketServer(port: number = 3001): PlcWebSocketServer {
  if (!serverInstance) {
    serverInstance = new PlcWebSocketServer({ port })
  }
  return serverInstance
}

/**
 * Get the current server instance
 */
export function getPlcWebSocketServer(): PlcWebSocketServer | null {
  return serverInstance
}

/**
 * Stop and cleanup the PLC WebSocket server
 */
export function stopPlcWebSocketServer(): void {
  if (serverInstance) {
    serverInstance.stop()
    serverInstance = null
  }
}
