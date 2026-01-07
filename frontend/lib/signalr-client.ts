"use client"

import { HubConnection, HubConnectionBuilder, LogLevel } from '@microsoft/signalr'
import { useEffect, useRef, useState } from 'react'

export interface IOUpdate {
  Id: number
  Result: 'Passed' | 'Failed' | 'Cleared' | 'Not Tested'
  State: 'TRUE' | 'FALSE'
  Timestamp?: string
  Comments?: string
}

export interface SignalRConnection {
  connection: HubConnection | null
  isConnected: boolean
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  onIOUpdate: (callback: (update: IOUpdate) => void) => void
  offIOUpdate: (callback: (update: IOUpdate) => void) => void
}

export function useSignalR(hubUrl: string = 'http://localhost:5000/hub'): SignalRConnection {
  const [connection, setConnection] = useState<HubConnection | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const connectionRef = useRef<HubConnection | null>(null)
  const callbacksRef = useRef<Set<(update: IOUpdate) => void>>(new Set())

  const connect = async () => {
    if (connectionRef.current?.state === 'Connected') {
      return
    }

    try {
      const newConnection = new HubConnectionBuilder()
        .withUrl(hubUrl, {
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
    connect,
    disconnect,
    onIOUpdate,
    offIOUpdate
  }
}

// Standalone SignalR service for non-React usage
export class SignalRService {
  private connection: HubConnection | null = null
  private callbacks: Set<(update: IOUpdate) => void> = new Set()
  private isConnected = false

  constructor(private hubUrl: string = 'http://localhost:5000/hub') {}

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
