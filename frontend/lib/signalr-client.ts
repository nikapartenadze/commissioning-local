"use client"

import { HubConnection, HubConnectionBuilder, LogLevel } from '@microsoft/signalr'
import { useEffect, useRef, useState } from 'react'
import { getSignalRHubUrl, refreshRuntimeConfig, clearRuntimeConfigCache } from './api-config'

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
  errorCount: number
}

export interface SignalRConnection {
  connection: HubConnection | null
  isConnected: boolean
  isConfigReloading: boolean
  isTesting: boolean
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  onIOUpdate: (callback: (update: IOUpdate) => void) => void
  offIOUpdate: (callback: (update: IOUpdate) => void) => void
  onConfigurationChange: (callback: (event: ConfigurationEvent) => void) => void
  offConfigurationChange: (callback: (event: ConfigurationEvent) => void) => void
  onTestingStateChange: (callback: (isTesting: boolean) => void) => void
  offTestingStateChange: (callback: (isTesting: boolean) => void) => void
  onCommentUpdate: (callback: (update: CommentUpdate) => void) => void
  offCommentUpdate: (callback: (update: CommentUpdate) => void) => void
  onNetworkStatusChange: (callback: (update: NetworkStatusUpdate) => void) => void
  offNetworkStatusChange: (callback: (update: NetworkStatusUpdate) => void) => void
}

export function useSignalR(hubUrl?: string): SignalRConnection {
  // Use dynamic URL if not provided
  const effectiveHubUrl = hubUrl || (typeof window !== 'undefined' ? getSignalRHubUrl() : 'http://localhost:5000/hub')
  const [connection, setConnection] = useState<HubConnection | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isConfigReloading, setIsConfigReloading] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const connectionRef = useRef<HubConnection | null>(null)
  const callbacksRef = useRef<Set<(update: IOUpdate) => void>>(new Set())
  const configCallbacksRef = useRef<Set<(event: ConfigurationEvent) => void>>(new Set())
  const testingCallbacksRef = useRef<Set<(isTesting: boolean) => void>>(new Set())
  const commentCallbacksRef = useRef<Set<(update: CommentUpdate) => void>>(new Set())
  const networkStatusCallbacksRef = useRef<Set<(update: NetworkStatusUpdate) => void>>(new Set())

  const connect = async () => {
    if (connectionRef.current?.state === 'Connected') {
      return
    }

    try {
      const newConnection = new HubConnectionBuilder()
        .withUrl(effectiveHubUrl, {
          withCredentials: false,
        })
        .configureLogging(process.env.NODE_ENV === 'production' ? LogLevel.Warning : LogLevel.Information)
        .withAutomaticReconnect({
          nextRetryDelayInMilliseconds: retryContext => {
            if (retryContext.previousRetryCount === 0) {
              return 0
            }
            return Math.min(1000 * Math.pow(2, retryContext.previousRetryCount), 30000)
          }
        })
        .build()

      // Register the UpdateIO handler (for result changes)
      newConnection.on('UpdateIO', (id: number, result: string, state: string, timestamp?: string, comments?: string) => {
        const update: IOUpdate = {
          Id: id,
          Result: result as IOUpdate['Result'],
          State: state as IOUpdate['State'],
          Timestamp: timestamp,
          Comments: comments
        }

        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR UpdateIO received:', update)
        }
        
        // Call all registered callbacks
        callbacksRef.current.forEach(callback => {
          try {
            callback(update)
          } catch (error) {
            console.error('Error in SignalR callback:', error)
          }
        })
      })

      // Register the UpdateState handler (for state changes only)
      newConnection.on('UpdateState', (id: number, state: string) => {
        const update: IOUpdate = {
          Id: id,
          Result: 'Not Tested', // Don't change result on state updates
          State: state as IOUpdate['State'],
          Timestamp: undefined,
          Comments: undefined
        }

        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR UpdateState received:', update)
        }

        // Call all registered callbacks
        callbacksRef.current.forEach(callback => {
          try {
            callback(update)
          } catch (error) {
            console.error('Error in SignalR callback:', error)
          }
        })
      })

      // Register the ConfigurationReloading handler (config.json changed externally)
      newConnection.on('ConfigurationReloading', () => {
        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR ConfigurationReloading received')
        }
        setIsConfigReloading(true)
        clearRuntimeConfigCache() // Clear cache so next fetch gets fresh data

        // Notify registered callbacks
        const event: ConfigurationEvent = { type: 'reloading' }
        configCallbacksRef.current.forEach(callback => {
          try {
            callback(event)
          } catch (error) {
            console.error('Error in configuration callback:', error)
          }
        })
      })

      // Register the ConfigurationReloaded handler (config reload complete)
      newConnection.on('ConfigurationReloaded', async () => {
        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR ConfigurationReloaded received')
        }
        setIsConfigReloading(false)

        // Refresh the runtime config cache
        try {
          await refreshRuntimeConfig()
        } catch (error) {
          console.error('Error refreshing runtime config:', error)
        }

        // Notify registered callbacks
        const event: ConfigurationEvent = { type: 'reloaded' }
        configCallbacksRef.current.forEach(callback => {
          try {
            callback(event)
          } catch (error) {
            console.error('Error in configuration callback:', error)
          }
        })
      })

      // Register the TestingStateChanged handler (testing started/stopped)
      newConnection.on('TestingStateChanged', (testingState: boolean) => {
        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR TestingStateChanged received:', testingState)
        }
        setIsTesting(testingState)

        // Notify registered callbacks
        testingCallbacksRef.current.forEach(callback => {
          try {
            callback(testingState)
          } catch (error) {
            console.error('Error in testing state callback:', error)
          }
        })
      })

      // Register the CommentUpdate handler (comment edited)
      newConnection.on('CommentUpdate', (ioId: number, comments: string) => {
        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR CommentUpdate received:', ioId, comments)
        }

        const update: CommentUpdate = { ioId, comments }

        // Notify registered callbacks
        commentCallbacksRef.current.forEach(callback => {
          try {
            callback(update)
          } catch (error) {
            console.error('Error in comment update callback:', error)
          }
        })
      })

      // Register the NetworkStatusChanged handler (module status changes)
      newConnection.on('NetworkStatusChanged', (moduleName: string, status: string, errorCount: number) => {
        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR NetworkStatusChanged received:', moduleName, status, errorCount)
        }

        const update: NetworkStatusUpdate = { moduleName, status, errorCount }

        networkStatusCallbacksRef.current.forEach(callback => {
          try {
            callback(update)
          } catch (error) {
            console.error('Error in network status callback:', error)
          }
        })
      })

      // Connection event handlers
      newConnection.onclose((error) => {
        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR connection closed:', error)
        }
        setIsConnected(false)
      })

      newConnection.onreconnecting((error) => {
        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR reconnecting:', error)
        }
        setIsConnected(false)
      })

      newConnection.onreconnected((connectionId) => {
        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR reconnected:', connectionId)
        }
        setIsConnected(true)
      })

      // Start the connection
      await newConnection.start()
      if (process.env.NODE_ENV === 'development') {
        console.log('SignalR connected successfully')
      }
      
      setConnection(newConnection)
      connectionRef.current = newConnection
      setIsConnected(true)

    } catch (error) {
      console.error('SignalR connection failed:', error)
      setIsConnected(false)
    }
  }

  const disconnect = async () => {
    if (connectionRef.current) {
      try {
        await connectionRef.current.stop()
        console.log('SignalR disconnected')
      } catch (error) {
        console.error('Error disconnecting SignalR:', error)
      } finally {
        setConnection(null)
        connectionRef.current = null
        setIsConnected(false)
      }
    }
  }

  const onIOUpdate = (callback: (update: IOUpdate) => void) => {
    callbacksRef.current.add(callback)
  }

  const offIOUpdate = (callback: (update: IOUpdate) => void) => {
    callbacksRef.current.delete(callback)
  }

  const onConfigurationChange = (callback: (event: ConfigurationEvent) => void) => {
    configCallbacksRef.current.add(callback)
  }

  const offConfigurationChange = (callback: (event: ConfigurationEvent) => void) => {
    configCallbacksRef.current.delete(callback)
  }

  const onTestingStateChange = (callback: (isTesting: boolean) => void) => {
    testingCallbacksRef.current.add(callback)
  }

  const offTestingStateChange = (callback: (isTesting: boolean) => void) => {
    testingCallbacksRef.current.delete(callback)
  }

  const onCommentUpdate = (callback: (update: CommentUpdate) => void) => {
    commentCallbacksRef.current.add(callback)
  }

  const offCommentUpdate = (callback: (update: CommentUpdate) => void) => {
    commentCallbacksRef.current.delete(callback)
  }

  const onNetworkStatusChange = (callback: (update: NetworkStatusUpdate) => void) => {
    networkStatusCallbacksRef.current.add(callback)
  }

  const offNetworkStatusChange = (callback: (update: NetworkStatusUpdate) => void) => {
    networkStatusCallbacksRef.current.delete(callback)
  }

  // Auto-connect on mount
  useEffect(() => {
    connect()

    // Cleanup on unmount
    return () => {
      disconnect()
    }
  }, [])

  return {
    connection,
    isConnected,
    isConfigReloading,
    isTesting,
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
    offNetworkStatusChange
  }
}

// Standalone SignalR service for non-React usage
export class SignalRService {
  private connection: HubConnection | null = null
  private callbacks: Set<(update: IOUpdate) => void> = new Set()
  private isConnected = false

  constructor(private hubUrl: string = typeof window !== 'undefined' ? getSignalRHubUrl() : 'http://localhost:5000/hub') {}

  async connect(): Promise<void> {
    if (this.connection?.state === 'Connected') {
      return
    }

    try {
      this.connection = new HubConnectionBuilder()
        .withUrl(this.hubUrl, {
          withCredentials: false,
        })
        .configureLogging(process.env.NODE_ENV === 'production' ? LogLevel.Warning : LogLevel.Information)
        .withAutomaticReconnect()
        .build()

      // Register the UpdateIO handler
      this.connection.on('UpdateIO', (id: number, result: string, state: string, timestamp?: string, comments?: string) => {
        const update: IOUpdate = {
          Id: id,
          Result: result as IOUpdate['Result'],
          State: state as IOUpdate['State'],
          Timestamp: timestamp,
          Comments: comments
        }

        if (process.env.NODE_ENV === 'development') {
          console.log('SignalR UpdateIO received:', update)
        }
        
        // Call all registered callbacks
        this.callbacks.forEach(callback => {
          try {
            callback(update)
          } catch (error) {
            console.error('Error in SignalR callback:', error)
          }
        })
      })

      await this.connection.start()
      console.log('SignalR connected successfully')
      this.isConnected = true

    } catch (error) {
      console.error('SignalR connection failed:', error)
      this.isConnected = false
      throw error
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      try {
        await this.connection.stop()
        console.log('SignalR disconnected')
      } catch (error) {
        console.error('Error disconnecting SignalR:', error)
      } finally {
        this.connection = null
        this.isConnected = false
      }
    }
  }

  onIOUpdate(callback: (update: IOUpdate) => void): void {
    this.callbacks.add(callback)
  }

  offIOUpdate(callback: (update: IOUpdate) => void): void {
    this.callbacks.delete(callback)
  }

  getConnectionState(): boolean {
    return this.isConnected && this.connection?.state === 'Connected'
  }
}
