/**
 * PLC Communication Service
 * Handles real-time communication with PLC via WebSocket/HTTP
 */

import { API_ENDPOINTS } from './api-config'

export interface PlcConfig {
  ip: string
  path: string
  subsystemId: string
  apiPassword?: string
  remoteUrl?: string
}

export interface IoState {
  id: number
  name: string
  state: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
}

export interface PlcConnectionStatus {
  isConnected: boolean
  isTesting: boolean
  lastUpdate: Date
}

export class PlcCommunicationService {
  private config: PlcConfig
  private ws: WebSocket | null = null
  private reconnectInterval: NodeJS.Timeout | null = null
  private status: PlcConnectionStatus = {
    isConnected: false,
    isTesting: false,
    lastUpdate: new Date()
  }
  private listeners: Set<(status: PlcConnectionStatus) => void> = new Set()
  private ioStateListeners: Set<(ios: IoState[]) => void> = new Set()
  private currentIos: IoState[] = []

  constructor(config: PlcConfig) {
    this.config = config
  }

  // Initialize PLC connection
  async initialize(): Promise<boolean> {
    try {
      if (process.env.NODE_ENV === 'development') {
        console.log('🔌 Initializing PLC connection...', this.config)
      }
      
      // Test network connectivity first
      const networkOk = await this.testNetworkConnectivity()
      if (!networkOk) {
        console.error('❌ Network connectivity test failed')
        return false
      }

      // Connect to WebSocket for real-time updates
      await this.connectWebSocket()
      
      console.log('✅ PLC communication initialized')
      return true
    } catch (error) {
      console.error('❌ Failed to initialize PLC communication:', error)
      return false
    }
  }

  // Test network connectivity to PLC
  private async testNetworkConnectivity(): Promise<boolean> {
    try {
      const response = await fetch(API_ENDPOINTS.plcTestConnection, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: this.config.ip,
          port: 44818 // Standard Ethernet/IP port
        })
      })
      
      return response.ok
    } catch (error) {
      console.error('Network connectivity test failed:', error)
      return false
    }
  }

  private async connectWebSocket(): Promise<void> {
    this.updateStatus({ isConnected: true })
    return Promise.resolve()
  }

  // Handle incoming WebSocket messages
  private handleWebSocketMessage(message: any): void {
    switch (message.type) {
      case 'io-update':
        this.currentIos = message.data
        this.notifyIoStateListeners()
        break
      case 'status-update':
        this.updateStatus(message.data)
        break
    }
  }

  // Schedule reconnection
  private scheduleReconnect(): void {
    if (this.reconnectInterval) return

    this.reconnectInterval = setTimeout(() => {
      this.reconnectInterval = null
      this.connectWebSocket().catch(console.error)
    }, 5000)
  }

  // Update connection status
  private updateStatus(updates: Partial<PlcConnectionStatus>): void {
    // Don't override testing state from external updates - only allow local control
    const { isTesting, ...otherUpdates } = updates
    this.status = { 
      ...this.status, 
      ...otherUpdates, 
      lastUpdate: new Date() 
    }
    this.notifyStatusListeners()
  }

  // Notify status listeners
  private notifyStatusListeners(): void {
    this.listeners.forEach(listener => listener(this.status))
  }

  // Notify IO state listeners
  private notifyIoStateListeners(): void {
    this.ioStateListeners.forEach(listener => listener(this.currentIos))
  }

  // Public methods
  public getStatus(): PlcConnectionStatus {
    return this.status
  }

  public getCurrentIos(): IoState[] {
    return this.currentIos
  }

  public subscribeToStatus(callback: (status: PlcConnectionStatus) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  public subscribeToIoState(callback: (ios: IoState[]) => void): () => void {
    this.ioStateListeners.add(callback)
    return () => this.ioStateListeners.delete(callback)
  }

  // Toggle testing mode
  public async toggleTesting(): Promise<boolean> {
    try {
      const response = await fetch(API_ENDPOINTS.testingToggle, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      if (response.ok) {
        const result = await response.json()
        // Allow testing state update only from explicit toggle action
        this.status = { ...this.status, isTesting: result.isTesting, lastUpdate: new Date() }
        this.notifyStatusListeners()
        return result.isTesting
      }
      return false
    } catch (error) {
      console.error('Failed to toggle testing:', error)
      return false
    }
  }

  // Fire an output (simulate PLC write)
  public async fireOutput(ioId: number): Promise<boolean> {
    try {
      const response = await fetch(API_ENDPOINTS.ioFireOutput(ioId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' })
      })

      return response.ok
    } catch (error) {
      console.error('Failed to fire output:', error)
      return false
    }
  }

  // Mark test as failed
  public async markTestFailed(ioId: number, comments: string): Promise<boolean> {
    try {
      const response = await fetch(API_ENDPOINTS.ioFail(ioId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: 'Fail', comments })
      })

      return response.ok
    } catch (error) {
      console.error('Failed to mark test as failed:', error)
      return false
    }
  }

  // Mark test as passed
  public async markTestPassed(ioId: number): Promise<boolean> {
    try {
      const response = await fetch(API_ENDPOINTS.ioPass(ioId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: 'Pass', comments: '' })
      })

      return response.ok
    } catch (error) {
      console.error('Failed to mark test as passed:', error)
      return false
    }
  }

  // Update configuration
  public updateConfig(newConfig: Partial<PlcConfig>): void {
    this.config = { ...this.config, ...newConfig }
    
    // Reinitialize with new config
    this.disconnect()
    this.initialize()
  }

  // Disconnect and cleanup
  public disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval)
      this.reconnectInterval = null
    }
    
    this.updateStatus({ isConnected: false, isTesting: false })
  }
}

// Singleton instance
let plcService: PlcCommunicationService | null = null

export function getPlcService(config?: PlcConfig): PlcCommunicationService {
  if (!plcService && config) {
    plcService = new PlcCommunicationService(config)
  }
  return plcService!
}

export function initializePlcService(config: PlcConfig): Promise<PlcCommunicationService> {
  plcService = new PlcCommunicationService(config)
  return plcService.initialize().then(() => plcService!)
}
