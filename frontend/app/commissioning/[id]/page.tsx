"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useParams, useRouter } from "next/navigation"
import { useUser } from "@/lib/user-context"
import { PlcToolbar } from "@/components/plc-toolbar"
import { EnhancedIoDataGrid } from "@/components/enhanced-io-data-grid"
import { PlcConfigDialog } from "@/components/plc-config-dialog"
import { TestResultsChart } from "@/components/test-results-chart"
import { AllTestHistoryDialog } from "@/components/all-test-history-dialog"
import { FireOutputDialog } from "@/components/fire-output-dialog"
import { NetworkStatusBreadcrumbs } from "@/components/network-status-breadcrumbs"
import { TagStatusPanel } from "@/components/tag-status-panel"
import { ValueChangeDialog } from "@/components/value-change-dialog"
import { FailCommentDialog } from "@/components/fail-comment-dialog"
import { CloudSyncDialog } from "@/components/cloud-sync-dialog"
import { ErrorLogPanel } from "@/components/error-log-panel"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/theme-toggle"
import { UserMenu } from "@/components/user-menu"
import { Download, Settings, BarChart3, History } from "lucide-react"
import { toast } from "@/hooks/use-toast"
import {
  PlcCommunicationService,
  PlcConfig,
  PlcConnectionStatus,
  IoState
} from "@/lib/plc-communication"
import { useSignalR, IOUpdate, CommentUpdate, ErrorEvent } from "@/lib/signalr-client"
import { API_ENDPOINTS, getSignalRHubUrl, authFetch, fetchWithRetry } from "@/lib/api-config"
import { logger } from "@/lib/logger"

interface IoItem {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  state: string | null
  subsystemName: string
}

interface ChartData {
  passed: number
  failed: number
  notTested: number
  total: number
  passedPercent: number
  failedPercent: number
  notTestedPercent: number
}

function calculateTestResults(ios: IoItem[]): ChartData {
  const total = ios.length
  const passed = ios.filter(io => io.result === 'Passed').length
  const failed = ios.filter(io => io.result === 'Failed').length
  const notTested = total - passed - failed

  return {
    passed,
    failed,
    notTested,
    total,
    passedPercent: total > 0 ? (passed / total) * 100 : 0,
    failedPercent: total > 0 ? (failed / total) * 100 : 0,
    notTestedPercent: total > 0 ? (notTested / total) * 100 : 0
  }
}

export default function CommissioningPage() {
  const params = useParams()
  const router = useRouter()
  const { currentUser, isLoading: userLoading } = useUser()
  const projectId = parseInt(params.id as string)
  
  // Redirect to login if not authenticated
  useEffect(() => {
    if (!userLoading && !currentUser) {
      router.push('/')
    }
  }, [currentUser, userLoading, router])

  // Check simulator status on mount
  useEffect(() => {
    const checkSimulatorStatus = async () => {
      try {
        const response = await authFetch(API_ENDPOINTS.simulatorStatus)
        if (response.ok) {
          const data = await response.json()
          setIsSimulatorEnabled(data.enabled)
        }
      } catch (error) {
        logger.error('Error checking simulator status:', error)
      }
    }
    
    checkSimulatorStatus()
  }, [])
  
  // State management
  const [ios, setIos] = useState<IoItem[]>([])
  const [filteredIos, setFilteredIos] = useState<IoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [plcService, setPlcService] = useState<PlcCommunicationService | null>(null)
  const [plcStatus, setPlcStatus] = useState<PlcConnectionStatus>({
    isConnected: false,
    isTesting: false,
    lastUpdate: new Date()
  })
  const [showConfigDialog, setShowConfigDialog] = useState(false)
  const [showGraph, setShowGraph] = useState(false)
  const [showHistoryDialog, setShowHistoryDialog] = useState(false)
  const [showFireOutputDialog, setShowFireOutputDialog] = useState(false)
  const [showValueChangeDialog, setShowValueChangeDialog] = useState(false)
  const [showFailCommentDialog, setShowFailCommentDialog] = useState(false)
  const [showCloudSyncDialog, setShowCloudSyncDialog] = useState(false)
  const [selectedIo, setSelectedIo] = useState<IoItem | null>(null)
  const [pendingFailIo, setPendingFailIo] = useState<IoItem | null>(null)
  const [previousStates, setPreviousStates] = useState<Record<number, string>>({})
  const [outputFiringInProgress, setOutputFiringInProgress] = useState<Record<number, boolean>>({})
  const [isOrderMode, setIsOrderMode] = useState(true)
  
  // Dialog queue for handling multiple simultaneous triggers
  const [dialogQueue, setDialogQueue] = useState<IoItem[]>([])
  const [currentDialogIo, setCurrentDialogIo] = useState<IoItem | null>(null)
  const [isSimulatorEnabled, setIsSimulatorEnabled] = useState(false)
  const [quickFilter, setQuickFilter] = useState<'failed' | 'not-tested' | 'passed' | null>(null)
  const [confirmClearIo, setConfirmClearIo] = useState<IoItem | null>(null)
  const [errorLog, setErrorLog] = useState<ErrorEvent[]>([])


  // Helper function to check if an IO is an output
  const isOutput = (ioName: string | null): boolean => {
    if (!ioName) return false
    return ioName.includes(':O.') || ioName.includes(':SO.') || ioName.includes('.O.') || ioName.includes(':O:') || ioName.includes('.Outputs.') || ioName.endsWith('.DO')
  }

  // Auto-show next dialog from queue
  useEffect(() => {
    // Don't advance queue if FailCommentDialog is open
    if (showFailCommentDialog) {
      return
    }

    if (!currentDialogIo && dialogQueue.length > 0) {
      // Show next dialog from queue
      const nextIo = dialogQueue[0]
      setCurrentDialogIo(nextIo)
      setDialogQueue(prev => prev.slice(1)) // Remove from queue
      setShowValueChangeDialog(true)
      if (process.env.NODE_ENV === 'development') {
        console.log('📋 Showing next dialog from queue:', nextIo.name, 'Remaining:', dialogQueue.length - 1)
      }
    } else if (!currentDialogIo && dialogQueue.length === 0) {
      // Close dialog when queue is empty
      setShowValueChangeDialog(false)
    }
  }, [dialogQueue, currentDialogIo, showFailCommentDialog])

  // Add IO to dialog queue
  const addToDialogQueue = useCallback((io: IoItem) => {
    if (process.env.NODE_ENV === 'development') {
      console.log('➕ Adding to dialog queue:', io.name)
    }
    
    setDialogQueue(prev => {
      // Check if this IO is already in queue (avoid duplicates)
      const isAlreadyInQueue = prev.some(queuedIo => queuedIo.id === io.id)
      if (isAlreadyInQueue) {
        if (process.env.NODE_ENV === 'development') {
          console.log('⚠️ IO already in queue, skipping:', io.name)
        }
        return prev
      }
      const newQueue = [...prev, io]
      if (process.env.NODE_ENV === 'development') {
        console.log('📋 Queue updated. Total waiting:', newQueue.length)
      }
      return newQueue
    })
    
    // Also check if this IO is currently being shown (use state updater for latest value)
    setCurrentDialogIo(current => {
      if (current && current.id === io.id) {
        if (process.env.NODE_ENV === 'development') {
          console.log('⚠️ IO already being shown in dialog, removing from queue')
        }
        // Remove it from queue if it somehow got added
        setDialogQueue(q => q.filter(queuedIo => queuedIo.id !== io.id))
      }
      return current
    })
  }, [])

  // Navigation handlers - removed back button since we go directly to testing page

  const handleSwitchSubsystem = async (subsystemId: number) => {
    try {
      // In a real implementation, this would:
      // 1. Update the C# backend configuration with the new subsystem ID
      // 2. Trigger a reconnection to the new subsystem
      // 3. Navigate to the new subsystem's testing page
      
      router.push(`/commissioning/${subsystemId}`)
    } catch (error) {
      logger.error('Failed to switch subsystem:', error)
    }
  }

  const handleConfigureProject = (projectName: string) => {
    // In a real implementation, this would open a configuration dialog
    toast({ title: `Configure project ${projectName}`, description: "Configuration dialog not yet implemented" })
  }

  // PLC Configuration
  const [plcConfig, setPlcConfig] = useState<PlcConfig>({
    ip: "192.168.1.100",
    path: "1,0",
    subsystemId: projectId.toString(), // Use the URL parameter as initial subsystem ID
    apiPassword: "",
    remoteUrl: ""
  })

  // SignalR connection for real-time updates
  const signalR = useSignalR(getSignalRHubUrl())

  // Load PLC config function (defined before useEffect that uses it)
  const loadPlcConfig = useCallback(async (updateTestingState: boolean = true) => {
    try {
      const response = await fetchWithRetry(API_ENDPOINTS.status)
      if (response.ok) {
        const status = await response.json()
        const newConfig = {
          ip: status.plcIp || "192.168.20.14",
          path: status.plcPath || "1,1",
          subsystemId: status.subsystemId || "16",
          apiPassword: status.apiPassword || "",
          remoteUrl: status.remoteUrl || ""
        }
        
        // Only update if config actually changed (prevent unnecessary re-initializations)
        setPlcConfig(prev => {
          if (prev.ip === newConfig.ip && 
              prev.path === newConfig.path && 
              prev.subsystemId === newConfig.subsystemId &&
              prev.apiPassword === newConfig.apiPassword &&
              prev.remoteUrl === newConfig.remoteUrl) {
            return prev // Return same reference if nothing changed
          }
          return newConfig
        })
        
        // Update PLC status - only update testing state if explicitly requested
        setPlcStatus(prev => ({
          ...prev,
          isConnected: status.plcConnected || false,
          isTesting: updateTestingState ? (status.isTesting || false) : prev.isTesting
        }))
        
        if (process.env.NODE_ENV === 'development') {
          console.log('✅ Loaded PLC config from C# backend:', status)
        }
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('❌ Failed to load PLC config from C# backend:', error)
      }
    }
  }, [])

  // Load initial data
  useEffect(() => {
    loadIos()
    loadPlcConfig()
    
    // Refresh status every 5 seconds to keep connection state in sync (but not testing state)
    const interval = setInterval(() => {
      loadPlcConfig(false) // Don't override testing state
    }, 5000)
    
    return () => clearInterval(interval)
  }, [projectId, loadPlcConfig])

  // Initialize PLC service
  useEffect(() => {
    if (plcConfig) {
      const service = new PlcCommunicationService(plcConfig)
      setPlcService(service)
      
      // DON'T subscribe to status updates - we manage testing state locally
      // const unsubscribeStatus = service.subscribeToStatus((status) => {
      //   setPlcStatus(status)
      // })
      
      // Subscribe to IO state updates
      const unsubscribeIoState = service.subscribeToIoState((ioStates) => {
        // Update IO states in real-time
        setIos(prevIos => 
          prevIos.map(io => {
            const ioState = ioStates.find(state => state.id === io.id)
            return ioState ? { ...io, state: ioState.state } : io
          })
        )
      })
      
      // Initialize PLC connection
      service.initialize().then(success => {
        if (process.env.NODE_ENV === 'development') {
          if (success) {
            console.log('✅ PLC service initialized successfully')
          } else {
            console.log('❌ PLC service initialization failed')
          }
        }
      })
      
      return () => {
        // unsubscribeStatus()
        unsubscribeIoState()
        service.disconnect()
      }
    }
  }, [plcConfig])

  // Use refs for frequently changing values to avoid re-registering SignalR handlers
  const plcStatusRef = useRef(plcStatus)
  const outputFiringInProgressRef = useRef(outputFiringInProgress)
  const previousStatesRef = useRef(previousStates)
  
  // Keep refs updated
  useEffect(() => {
    plcStatusRef.current = plcStatus
  }, [plcStatus])
  
  useEffect(() => {
    outputFiringInProgressRef.current = outputFiringInProgress
  }, [outputFiringInProgress])
  
  useEffect(() => {
    previousStatesRef.current = previousStates
  }, [previousStates])

  // Handle SignalR testing state changes
  useEffect(() => {
    const handleTestingStateChange = (newIsTesting: boolean) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('📡 SignalR TestingStateChanged:', newIsTesting)
      }
      setPlcStatus(prev => ({
        ...prev,
        isTesting: newIsTesting
      }))
    }

    signalR.onTestingStateChange(handleTestingStateChange)

    return () => {
      signalR.offTestingStateChange(handleTestingStateChange)
    }
  }, [signalR.onTestingStateChange, signalR.offTestingStateChange])

  // Handle SignalR comment updates
  useEffect(() => {
    const handleCommentUpdate = (update: CommentUpdate) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('📡 SignalR CommentUpdate:', update)
      }
      setIos(prevIos =>
        prevIos.map(io =>
          io.id === update.ioId ? { ...io, comments: update.comments } : io
        )
      )
    }

    signalR.onCommentUpdate(handleCommentUpdate)

    return () => {
      signalR.offCommentUpdate(handleCommentUpdate)
    }
  }, [signalR.onCommentUpdate, signalR.offCommentUpdate])

  // Handle SignalR error events (backend-pushed errors + connection state changes)
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      // Add to error log (newest first, max 50)
      setErrorLog(prev => [event, ...prev].slice(0, 50))

      // Show toast for errors and warnings
      if (event.severity === 'error') {
        toast({ title: event.message, variant: "destructive" })
      } else if (event.severity === 'warning') {
        toast({ title: event.message })
      } else if (event.severity === 'info') {
        toast({ title: event.message })
      }
    }

    signalR.onError(handleError)

    return () => {
      signalR.offError(handleError)
    }
  }, [signalR.onError, signalR.offError])

  // Handle SignalR real-time updates
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      console.log('🔗 SignalR connection status:', signalR.isConnected)
    }
    if (signalR.isConnected) {
      if (process.env.NODE_ENV === 'development') {
        console.log('🔗 SignalR connected - listening for real-time IO updates')
      }
      
      const handleIOUpdate = (update: IOUpdate) => {
        if (process.env.NODE_ENV === 'development') {
          console.log('📡 SignalR Update received:', update)
        }
        
        setIos(prevIos => 
          prevIos.map(io => {
            if (io.id === update.Id) {
              // Check if this is a state-only update or a full IO update
              // For outputs, if timestamp and comments are missing but result is "Not Tested", 
              // it might be a trigger from output firing (not a state-only update)
              const isStateOnlyUpdate = update.Result === 'Not Tested' && !update.Timestamp && !update.Comments && !isOutput(io.name)
              
              let updatedIo
              if (isStateOnlyUpdate) {
                // State-only update: only update the state, preserve result/timestamp/comments
                updatedIo = {
                  ...io,
                  state: update.State
                }
                if (process.env.NODE_ENV === 'development') {
                  console.log('📡 State-only update for:', io.name, 'New state:', update.State, 'Preserved result:', io.result)
                }
              } else {
                // Full IO update: update everything (result changes from Pass/Fail/Clear)
                updatedIo = {
                  ...io,
                  state: update.State,
                  result: update.Result === "Not Tested" ? null : update.Result,
                  timestamp: update.Timestamp || io.timestamp,
                  comments: update.Comments !== undefined ? update.Comments : io.comments // Handle null comments explicitly
                }
                if (process.env.NODE_ENV === 'development') {
                  console.log('📡 Full IO update for:', io.name, 'New state:', update.State, 'New result:', updatedIo.result)
                }
              }
              
              // Use refs for current values to avoid dependency issues
              const currentPlcStatus = plcStatusRef.current
              const currentOutputFiring = outputFiringInProgressRef.current
              const currentPreviousStates = previousStatesRef.current
              
              // Check if we should show the value change dialog
              const shouldShowDialog = currentPlcStatus.isTesting && !io.result && (
                // For inputs: show when state changes to TRUE
                (!isOutput(io.name) && currentPreviousStates[io.id] !== update.State && update.State === 'TRUE') ||
                // For outputs: show when triggered by output firing
                // Either firing is in progress OR we got a "Not Tested" update without timestamp/comments (trigger from backend)
                (isOutput(io.name) && update.Result === "Not Tested" && (
                  currentOutputFiring[io.id] || // Firing flag is set
                  (!update.Timestamp && !update.Comments) // Backend trigger (no timestamp/comments means it's a trigger)
                ))
              )
              
              if (shouldShowDialog) {
                if (process.env.NODE_ENV === 'development') {
                  console.log('💡 Triggering ValueChangeDialog for:', io.name, 'Type:', isOutput(io.name) ? 'OUTPUT' : 'INPUT', 'Current state:', update.State, 'Current result:', io.result)
                }
                // Add to queue instead of showing immediately
                addToDialogQueue(updatedIo)
              }
              
              // Update previous state
              setPreviousStates(prev => ({
                ...prev,
                [io.id]: update.State
              }))
              
              return updatedIo
            }
            return io
          })
        )
      }

      signalR.onIOUpdate(handleIOUpdate)

      return () => {
        signalR.offIOUpdate(handleIOUpdate)
      }
    }
  }, [signalR.isConnected, addToDialogQueue]) // Removed frequently changing dependencies, using refs instead

  const loadIos = async () => {
    try {
      setLoading(true)
      // Load IOs from C# backend (real PLC data) - retry on failure
      const response = await fetchWithRetry(API_ENDPOINTS.ios)
      if (response.ok) {
        const data = await response.json()
        setIos(data)
        setFilteredIos(data)
        
        // First untested IO found (for future use)
        // const firstUntested = data.find((io: IoItem) => !io.result)
      } else {
        logger.error('Failed to load IOs from C# backend:', response.status)
        toast({ title: "Failed to load IO data", description: `Backend returned ${response.status}`, variant: "destructive" })
        setIos([])
        setFilteredIos([])
      }
    } catch (error) {
      logger.error('Error loading IOs:', error)
      toast({ title: "Failed to load IO data", description: "Cannot connect to backend server", variant: "destructive" })
      setIos([])
      setFilteredIos([])
    } finally {
      setLoading(false)
    }
  }

  const handleFireOutput = async (io: IoItem, action: 'start' | 'stop') => {
    try {
      if (action === 'start') {
        // Mark that output firing is in progress for this IO
        setOutputFiringInProgress(prev => ({ ...prev, [io.id]: true }))
      } else if (action === 'stop') {
        // Clear the firing flag after a longer delay to ensure SignalR update arrives first
        // Backend sends the trigger after 250ms, so we need at least that + network delay
        setTimeout(() => {
          setOutputFiringInProgress(prev => ({ ...prev, [io.id]: false }))
        }, 1000) // Increased to 1000ms to ensure SignalR update arrives before clearing flag
      }

      if (process.env.NODE_ENV === 'development') {
        console.log(`🔥 Firing output ${action} for ${io.name}...`)
      }
      const response = await authFetch(API_ENDPOINTS.ioFireOutput(io.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      })
      
      if (response.ok) {
        if (process.env.NODE_ENV === 'development') {
          const result = await response.json()
          console.log(`✅ Output ${action} command sent for ${io.name}:`, result)
        }
        // SignalR will handle the real-time update
      } else {
        const errorText = await response.text()
        logger.error(`Failed to ${action} output:`, response.status, errorText)
      }
    } catch (error) {
      logger.error(`Error ${action}ing output:`, error)
    }
  }

  const handleMarkPassed = async (io: IoItem) => {
    // Save previous state for rollback
    const previousResult = io.result
    const previousTimestamp = io.timestamp

    try {
      // Optimistically update UI immediately for better UX
      setIos(prevIos => prevIos.map(i =>
        i.id === io.id ? { ...i, result: 'Passed', timestamp: new Date().toISOString() } : i
      ))

      if (process.env.NODE_ENV === 'development') {
        console.log('Calling C# backend to mark IO as passed:', io.id, io.name)
      }
      const response = await authFetch(API_ENDPOINTS.ioPass(io.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comments: '',
          currentUser: currentUser?.fullName || 'Unknown'
        })
      })

      if (response.ok) {
        toast({ title: `${io.name} marked as Passed` })
      } else {
        const errorText = await response.text()
        logger.error('Failed to mark IO as passed:', response.status, errorText)
        // Rollback optimistic update
        setIos(prevIos => prevIos.map(i =>
          i.id === io.id ? { ...i, result: previousResult, timestamp: previousTimestamp } : i
        ))
        toast({ title: "Failed to mark as passed", description: errorText, variant: "destructive" })
      }
    } catch (error) {
      logger.error('Error marking IO as passed:', error)
      // Rollback optimistic update
      setIos(prevIos => prevIos.map(i =>
        i.id === io.id ? { ...i, result: previousResult, timestamp: previousTimestamp } : i
      ))
      toast({ title: "Failed to mark as passed", description: "Network error", variant: "destructive" })
    }
  }

  const handleMarkFailed = async (io: IoItem, comments: string, failureMode?: string) => {
    // Save previous state for rollback
    const previousResult = io.result
    const previousComments = io.comments
    const previousTimestamp = io.timestamp

    try {
      // Optimistically update UI immediately for better UX
      setIos(prevIos => prevIos.map(i =>
        i.id === io.id ? { ...i, result: 'Failed', comments, timestamp: new Date().toISOString() } : i
      ))

      if (process.env.NODE_ENV === 'development') {
        console.log('Calling C# backend to mark IO as failed:', io.id, io.name, comments, failureMode)
      }
      const response = await authFetch(API_ENDPOINTS.ioFail(io.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comments,
          currentUser: currentUser?.fullName || 'Unknown',
          failureMode
        })
      })

      if (response.ok) {
        toast({ title: `${io.name} marked as Failed`, variant: "destructive" })
      } else {
        const errorText = await response.text()
        logger.error('Failed to mark IO as failed:', response.status, errorText)
        // Rollback optimistic update
        setIos(prevIos => prevIos.map(i =>
          i.id === io.id ? { ...i, result: previousResult, comments: previousComments, timestamp: previousTimestamp } : i
        ))
        toast({ title: "Failed to mark as failed", description: errorText, variant: "destructive" })
      }
    } catch (error) {
      logger.error('Error marking IO as failed:', error)
      // Rollback optimistic update
      setIos(prevIos => prevIos.map(i =>
        i.id === io.id ? { ...i, result: previousResult, comments: previousComments, timestamp: previousTimestamp } : i
      ))
      toast({ title: "Failed to mark as failed", description: "Network error", variant: "destructive" })
    }
  }

  const handleClearResult = async (io: IoItem) => {
    try {
      const response = await authFetch(API_ENDPOINTS.ioClear(io.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentUser: currentUser?.fullName || 'Unknown'
        })
      })
      
      if (response.ok) {
        if (process.env.NODE_ENV === 'development') {
          console.log('✅ IO cleared via C# backend')
        }
        // SignalR will handle the real-time update
      } else {
        logger.error('Failed to clear IO:', response.status)
      }
    } catch (error) {
      logger.error('Error clearing IO:', error)
    }
  }

  const handleRowClick = (io: IoItem) => {
    if (plcStatus.isTesting) {
      addToDialogQueue(io)
    }
  }

  const handleShowFireOutputDialog = (io: IoItem) => {
    setSelectedIo(io)
    setShowFireOutputDialog(true)
  }

  const handleValueChangeYes = (io: IoItem) => {
    // Mark as passed when user confirms the change
    if (process.env.NODE_ENV === 'development') {
      console.log('🎯 Pass button clicked for:', io.name)
    }
    handleMarkPassed(io)
    // Clear current dialog and show next in queue
    setCurrentDialogIo(null)
  }

  const handleValueChangeNo = (io: IoItem) => {
    // Show comment dialog before marking as failed
    if (process.env.NODE_ENV === 'development') {
      console.log('🎯 Fail button clicked for:', io.name, '- Opening comment dialog')
    }
    setPendingFailIo(io)
    setShowFailCommentDialog(true)
    // DON'T clear currentDialogIo here - wait for FailCommentDialog to complete
    // The queue will advance when FailCommentDialog submits or cancels
    setShowValueChangeDialog(false) // Hide ValueChangeDialog but keep currentDialogIo set
  }

  const handleFailCommentSubmit = (io: IoItem, comment: string, failureMode?: string) => {
    // Mark as failed with the provided comment and failure mode
    if (process.env.NODE_ENV === 'development') {
      console.log('🎯 Marking as failed with comment:', io.name, comment, 'Failure mode:', failureMode)
    }
    handleMarkFailed(io, comment, failureMode)
    setPendingFailIo(null)
    // NOW clear currentDialogIo to advance the queue
    setCurrentDialogIo(null)
  }

  const handleFailCommentCancel = () => {
    // User cancelled the fail comment dialog - don't mark as failed
    if (process.env.NODE_ENV === 'development') {
      console.log('🚫 Fail comment cancelled - not marking as failed')
    }
    setPendingFailIo(null)
    // NOW clear currentDialogIo to advance the queue
    setCurrentDialogIo(null)
  }

  const handleValueChangeCancel = (io: IoItem) => {
    // Do nothing, just close the dialog (no database update)
    if (process.env.NODE_ENV === 'development') {
      console.log('🚫 Value change dialog cancelled for', io.name, '- No database update')
    }
    // Clear current dialog and show next in queue
    setCurrentDialogIo(null)
  }

  const handleCommentChange = async (io: IoItem, comment: string) => {
    try {
      // Optimistically update UI
      setIos(prevIos => prevIos.map(i =>
        i.id === io.id ? { ...i, comments: comment } : i
      ))

      if (process.env.NODE_ENV === 'development') {
        console.log('💬 Updating comment for IO:', io.id, io.name, comment)
      }

      const response = await authFetch(API_ENDPOINTS.ioComment(io.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments: comment })
      })

      if (response.ok) {
        if (process.env.NODE_ENV === 'development') {
          console.log('✅ Comment updated via backend')
        }
        // SignalR will broadcast the update to other clients
      } else {
        logger.error('Failed to update comment:', response.status)
      }
    } catch (error) {
      logger.error('Error updating comment:', error)
    }
  }

  const handleClearTesting = async () => {
    try {
      // Clear all test results
      const clearPromises = ios.map(io =>
        authFetch(API_ENDPOINTS.ioClear(io.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentUser: currentUser?.fullName || 'Unknown'
          })
        })
      )
      
      await Promise.all(clearPromises)
      
      // Reload IOs to get updated data
      await loadIos()
      
      logger.log('All test results cleared')
    } catch (error) {
      logger.error('Error clearing test results:', error instanceof Error ? error.message : error)
    }
  }

  const handleCloudSync = () => {
    // Just open the cloud sync dialog - it handles everything
    setShowCloudSyncDialog(true)
  }

  const handleToggleSimulator = async () => {
    try {
      const endpoint = isSimulatorEnabled ? 'disable' : 'enable'
      const response = await fetch(endpoint === 'enable' ? API_ENDPOINTS.simulatorEnable : API_ENDPOINTS.simulatorDisable, {
        method: 'POST'
      })
      
      if (response.ok) {
        setIsSimulatorEnabled(!isSimulatorEnabled)
        logger.log(`Simulator ${!isSimulatorEnabled ? 'enabled' : 'disabled'}`)
      } else {
        logger.error('Failed to toggle simulator')
      }
    } catch (error) {
      logger.error('Error toggling simulator:', error)
    }
  }

  const handleConfigChange = async (newConfig: PlcConfig) => {
    logger.log('Config change triggered with:', newConfig)
    setPlcConfig(newConfig)
    setShowConfigDialog(false)

    // Wait a bit for C# backend to process the config change
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Reload the page to ensure fresh data
    window.location.reload()
  }

  const handleTestConnection = async (): Promise<boolean> => {
    // Test connection via C# backend (real PLC communication)
    try {
      const response = await authFetch(API_ENDPOINTS.plcTestConnection, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: plcConfig.ip,
          port: 44818
        })
      })
      const result = await response.json()
      return result.success
    } catch (error) {
      logger.error('C# backend connection test failed:', error)
      return false
    }
  }

  const handleToggleTesting = async () => {
    try {
      const response = await authFetch(API_ENDPOINTS.testingToggle, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      if (response.ok) {
        const result = await response.json()
        logger.log('Testing toggled:', result.isTesting)

        setPlcStatus(prev => ({
          ...prev,
          isTesting: result.isTesting
        }))
      } else {
        const errorText = await response.text()
        logger.error('Failed to toggle testing:', response.status, errorText)
      }
    } catch (error) {
      logger.error('Error toggling testing:', error)
    }
  }

  const handleDownloadCsv = () => {
    const csvContent = generateCsvContent(filteredIos)
    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `io-test-results-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    window.URL.revokeObjectURL(url)
  }

  const generateCsvContent = (ios: IoItem[]): string => {
    const headers = ['Name', 'Description', 'Subsystem', 'State', 'Result', 'Timestamp', 'Comments']
    const rows = ios.map(io => [
      io.name,
      io.description || '',
      io.subsystemName,
      io.state || '',
      io.result || '',
      io.timestamp || '',
      io.comments || ''
    ])
    
    return [headers, ...rows].map(row => 
      row.map(field => `"${field}"`).join(',')
    ).join('\n')
  }

  if (loading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-primary border-t-transparent mx-auto mb-4"></div>
          <p className="text-lg font-medium text-muted-foreground">Loading IO data...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Compact Header Bar */}
      <header className="bg-card border-b flex-shrink-0 z-50">
        <div className="flex items-center justify-between px-4 h-12">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-bold tracking-tight">IO CHECKOUT</h1>
            <div className="h-6 w-px bg-border" />
            <span className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
              SUB {plcConfig.subsystemId}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <UserMenu />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* SignalR Connection Warning - Shows when real-time updates are disconnected */}
      {!signalR.isConnected && (
        <div className="bg-red-500/10 border-b border-red-500/30 px-4 py-2 flex items-center gap-2 flex-shrink-0">
          <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm text-red-600 dark:text-red-400 font-medium">
            Real-time connection lost — Reconnecting...
          </span>
        </div>
      )}

      {/* Network Status - Shows PLC path, cloud connection, etc */}
      <NetworkStatusBreadcrumbs className="flex-shrink-0 border-b" />

      {/* Tag Status Panel - Shows PLC tag connection errors */}
      <TagStatusPanel className="flex-shrink-0" />

      {/* Error Log - Collapsible, only shows when errors exist */}
      {errorLog.length > 0 && (
        <ErrorLogPanel
          errors={errorLog}
          onClear={() => setErrorLog([])}
          className="flex-shrink-0"
        />
      )}

      {/* Main Toolbar - Full width */}
      <div className="flex-shrink-0">
        <PlcToolbar
          isTesting={plcStatus.isTesting}
          isPlcConnected={plcStatus.isConnected}
          isCloudConnected={true}
          totalIos={ios.length}
          passedIos={ios.filter(io => io.result === 'Passed').length}
          failedIos={ios.filter(io => io.result === 'Failed').length}
          notTestedIos={ios.filter(io => !io.result).length}
          onToggleTesting={handleToggleTesting}
          onShowGraph={() => setShowGraph(true)}
          onDownloadCsv={handleDownloadCsv}
          onShowHistory={() => setShowHistoryDialog(true)}
          onShowConfig={() => setShowConfigDialog(true)}
          onCloudSync={handleCloudSync}
          currentUser={currentUser}
          onToggleSimulator={handleToggleSimulator}
          isSimulatorEnabled={isSimulatorEnabled}
          activeFilter={quickFilter}
          onFilterChange={setQuickFilter}
        />
      </div>

      {/* Data Grid - Takes all remaining space */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <EnhancedIoDataGrid
            ios={ios}
            projectId={projectId}
            isTesting={plcStatus.isTesting}
            currentTestIo={null}
            onFilteredDataChange={setFilteredIos}
            onFireOutput={handleFireOutput}
            onMarkPassed={handleMarkPassed}
            onMarkFailed={(io) => {
              // Show comment dialog before marking as failed
              setPendingFailIo(io)
              setShowFailCommentDialog(true)
            }}
            onClearResult={(io) => setConfirmClearIo(io)}
            onRowClick={handleRowClick}
            onShowFireOutputDialog={handleShowFireOutputDialog}
            onCommentChange={handleCommentChange}
            activeQuickFilter={quickFilter}
          />
      </div>

      {/* Test Results Chart - Overlay */}
      {showGraph && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
          <TestResultsChart
            data={calculateTestResults(filteredIos)}
            onClose={() => setShowGraph(false)}
          />
        </div>
      )}

      {/* Configuration Dialog */}
        <PlcConfigDialog
          open={showConfigDialog}
          onOpenChange={setShowConfigDialog}
          config={plcConfig}
          onConfigChange={handleConfigChange}
          onTestConnection={handleTestConnection}
        />

        {/* All Test History Dialog */}
        <AllTestHistoryDialog
          open={showHistoryDialog}
          onOpenChange={setShowHistoryDialog}
          projectId={projectId}
          projectName={`Project ${projectId}`}
        />


        {/* Fire Output Dialog */}
        <FireOutputDialog
          open={showFireOutputDialog}
          onOpenChange={setShowFireOutputDialog}
          io={selectedIo}
          onFireOutput={handleFireOutput}
          isTesting={plcStatus.isTesting}
        />

        {/* Value Change Dialog */}
        <ValueChangeDialog
          open={showValueChangeDialog}
          onOpenChange={(open) => {
            if (!open) {
              // If dialog is being closed (clicked outside), treat it as cancel
              if (currentDialogIo) {
                handleValueChangeCancel(currentDialogIo)
              }
            }
          }}
          io={currentDialogIo}
          remainingCount={dialogQueue.length}
          onYes={handleValueChangeYes}
          onNo={handleValueChangeNo}
          onCancel={handleValueChangeCancel}
        />

        {/* Fail Comment Dialog */}
        <FailCommentDialog
          open={showFailCommentDialog}
          onOpenChange={setShowFailCommentDialog}
          io={pendingFailIo}
          onSubmit={handleFailCommentSubmit}
          onCancel={handleFailCommentCancel}
        />

        {/* Cloud Sync Dialog */}
        <CloudSyncDialog
          open={showCloudSyncDialog}
          onOpenChange={setShowCloudSyncDialog}
          subsystemId={plcConfig.subsystemId}
        />

        {/* Clear Result Confirmation Dialog */}
        <Dialog open={!!confirmClearIo} onOpenChange={(open) => { if (!open) setConfirmClearIo(null) }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Clear Test Result</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Clear test result for <span className="font-mono font-semibold text-foreground">{confirmClearIo?.name}</span>? This cannot be undone.
            </p>
            <DialogFooter className="flex gap-2">
              <Button variant="outline" onClick={() => setConfirmClearIo(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (confirmClearIo) {
                    handleClearResult(confirmClearIo)
                    toast({ title: `${confirmClearIo.name} result cleared` })
                    setConfirmClearIo(null)
                  }
                }}
              >
                Clear
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </div>
  )
}
