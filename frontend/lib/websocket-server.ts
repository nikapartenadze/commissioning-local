/**
 * WebSocket Server for Real-time PLC Communication
 * Simulates the C# app's real-time IO monitoring
 */

import { WebSocketServer, WebSocket } from 'ws'
import { prisma } from './prisma'

export interface PlcConfig {
  ip: string
  path: string
  subsystemId: string
}

export interface IoState {
  id: number
  name: string
  state: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
}

export class PlcWebSocketServer {
  private wss: WebSocketServer
  private clients: Map<WebSocket, PlcConfig> = new Map()
  private updateInterval: NodeJS.Timeout | null = null
  private isRunning = false

  constructor(port: number = 3001) {
    this.wss = new WebSocketServer({ port })
    this.setupWebSocketServer()
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('🔌 New PLC WebSocket client connected')
      
      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString())
          this.handleMessage(ws, message)
        } catch (error) {
          console.error('Error parsing WebSocket message:', error)
        }
      })

      ws.on('close', () => {
        console.log('🔌 PLC WebSocket client disconnected')
        this.clients.delete(ws)
      })

      ws.on('error', (error) => {
        console.error('PLC WebSocket error:', error)
        this.clients.delete(ws)
      })
    })

    console.log(`🔌 PLC WebSocket server listening on port ${this.wss.options.port}`)
  }

  private handleMessage(ws: WebSocket, message: any): void {
    switch (message.type) {
      case 'config':
        this.clients.set(ws, message.data)
        console.log('📋 PLC configuration received:', message.data)
        this.startRealTimeUpdates()
        break
    }
  }

  private startRealTimeUpdates(): void {
    if (this.isRunning) return
    
    this.isRunning = true
    console.log('🔄 Starting real-time IO updates')
    
    this.updateInterval = setInterval(async () => {
      await this.broadcastIoUpdates()
    }, 1000) // Update every second
  }

  private async broadcastIoUpdates(): Promise<void> {
    if (this.clients.size === 0) return

    try {
      // Get all IOs from database
      // Note: state is not stored in database - it's a runtime PLC value
      const ios = await prisma.io.findMany({
        select: {
          id: true,
          name: true,
          result: true,
          timestamp: true,
          comments: true
        }
      })

      // Simulate real-time state changes (state comes from PLC, not database)
      const iosWithSimulatedState = ios.map(io => ({
        ...io,
        state: this.simulateIoState(io.name || '', null) // State is simulated/generated, not from DB
      }))

      // Broadcast to all connected clients
      const message = JSON.stringify({
        type: 'io-update',
        data: iosWithSimulatedState
      })

      this.clients.forEach((config, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message)
        }
      })
    } catch (error) {
      console.error('Error broadcasting IO updates:', error)
    }
  }

  private simulateIoState(ioName: string, currentState: string | null): string {
    // Simulate realistic IO states based on the IO name
    // Note: currentState parameter is unused - state is generated, not from database
    if (ioName.includes(':O.') || ioName.includes('.O.') || ioName.includes('.Outputs.')) {
      // Output - simulate on/off states
      return Math.random() > 0.7 ? 'ON' : 'OFF'
    } else {
      // Input - simulate various states
      const states = ['LOW', 'HIGH', 'PULSE', 'STABLE']
      return states[Math.floor(Math.random() * states.length)]
    }
  }

  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval)
      this.updateInterval = null
    }
    
    this.wss.close()
    this.isRunning = false
    console.log('🛑 PLC WebSocket server stopped')
  }
}

// Global instance
let plcWebSocketServer: PlcWebSocketServer | null = null

export function startPlcWebSocketServer(port?: number): PlcWebSocketServer {
  if (!plcWebSocketServer) {
    plcWebSocketServer = new PlcWebSocketServer(port)
  }
  return plcWebSocketServer
}

export function stopPlcWebSocketServer(): void {
  if (plcWebSocketServer) {
    plcWebSocketServer.stop()
    plcWebSocketServer = null
  }
}
