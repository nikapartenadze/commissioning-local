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
import { TagStatusDialog, TagStatus } from "@/components/tag-status-dialog"
import { ValueChangeDialog } from "@/components/value-change-dialog"
import { FailCommentDialog } from "@/components/fail-comment-dialog"
import { CloudSyncDialog } from "@/components/cloud-sync-dialog"
import { ChangeRequestDialog } from "@/components/change-request-dialog"
import { ChangeRequestsPanel } from "@/components/change-requests-panel"
import NetworkTopologyView from "@/components/network-topology-view"
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
  PlcConfig,
  PlcConnectionStatus,
} from "@/lib/plc-communication"
import { useSignalR, IOUpdate, CommentUpdate, ErrorEvent } from "@/lib/signalr-client"
import { API_ENDPOINTS, getSignalRHubUrl, authFetch, fetchWithRetry } from "@/lib/api-config"
import { ErrorBoundary } from "@/components/error-boundary"
import { GuidedTour } from "@/components/guided-tour"
import { logger } from "@/lib/logger"

// Debug flags - set to true to enable specific logging
const DEBUG_FIRE = true      // Fire output logs
const DEBUG_OTHER = false    // All other logs

interface IoItem {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  state: string | null
  subsystemName: string
  assignedTo?: string | null
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
  const paramId = params.id as string
  const projectId = paramId === '_' ? 0 : parseInt(paramId)
  const isUnconfigured = paramId === '_' || isNaN(projectId)

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!userLoading && !currentUser) {
      router.push('/')
    }
  }, [currentUser, userLoading, router])

  // Auto-open config dialog when not configured — only for admins
  // Technicians can't configure PLC/cloud, so don't show them the dialog
  useEffect(() => {
    if (isUnconfigured && currentUser?.isAdmin) {
      setShowConfigDialog(true)
    }
  }, [isUnconfigured, currentUser])

  // State management
  const [ios, setIos] = useState<IoItem[]>([])
  const [filteredIos, setFilteredIos] = useState<IoItem[]>([])
  const [loading, setLoading] = useState(false)
  const [signalRWasConnected, setSignalRWasConnected] = useState(false)
  const [plcStatus, setPlcStatus] = useState<PlcConnectionStatus>({
    isConnected: false,
    isReconnecting: false,
    isTesting: false,
    lastUpdate: new Date()
  })
  const [isCloudConnected, setIsCloudConnected] = useState(false)
  const [showConfigDialog, setShowConfigDialog] = useState(false)
  const [showGraph, setShowGraph] = useState(false)
  const [activeTab, setActiveTab] = useState<'io' | 'network'>('io')
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

  const [quickFilter, setQuickFilter] = useState<'failed' | 'not-tested' | 'passed' | 'inputs' | 'outputs' | 'my-ios' | null>(null)
  const [showChangeRequestDialog, setShowChangeRequestDialog] = useState(false)
  const [showChangeRequestsPanel, setShowChangeRequestsPanel] = useState(false)
  const [changeRequestIo, setChangeRequestIo] = useState<IoItem | null>(null)
  const [confirmClearIo, setConfirmClearIo] = useState<IoItem | null>(null)
  const [errorLog, setErrorLog] = useState<ErrorEvent[]>([])
  const [tagStatus, setTagStatus] = useState<TagStatus | null>(null)
  const [showTagStatusDialog, setShowTagStatusDialog] = useState(false)
  const [showTour, setShowTour] = useState(false)

  // localStorage key for dialog queue persistence
  const DIALOG_QUEUE_STORAGE_KEY = 'io-checkout-dialog-queue'

  // Persist dialog queue + currentDialogIo to localStorage
  useEffect(() => {
    const allQueuedIds: number[] = [
      ...(currentDialogIo ? [currentDialogIo.id] : []),
      ...dialogQueue.map(io => io.id)
    ]
    if (allQueuedIds.length > 0) {
      localStorage.setItem(DIALOG_QUEUE_STORAGE_KEY, JSON.stringify(allQueuedIds))
    } else {
      localStorage.removeItem(DIALOG_QUEUE_STORAGE_KEY)
    }
  }, [dialogQueue, currentDialogIo])

  // Fetch tag status on mount, then receive updates via WebSocket
  useEffect(() => {
    const fetchTagStatus = async () => {
      try {
        const response = await authFetch(API_ENDPOINTS.tagStatus)
        if (response.ok) {
          const data = await response.json()
          setTagStatus(data)
        }
      } catch (error) {
        logger.error('Error fetching tag status:', error)
      }
    }

    fetchTagStatus()
  }, [])

  // Helper function to check if an IO is an output
  const isOutput = (ioName: string | null): boolean => {
    if (!ioName) return false
    return ioName.includes(':O.') || ioName.includes(':SO.') || ioName.includes('.O.') || ioName.includes(':O:') || ioName.includes('.Outputs.') || ioName.endsWith('.DO') || ioName.endsWith('_DO')
  }

  // Auto-show next dialog from queue
  useEffect(() => {
    // Don't advance queue if FailCommentDialog or FireOutputDialog is open
    // This ensures Pass/Fail dialog waits until user is done with Fire dialog
    if (showFailCommentDialog || showFireOutputDialog) {
      return
    }

    if (!currentDialogIo && dialogQueue.length > 0) {
      // Show next dialog from queue
      const nextIo = dialogQueue[0]
      setCurrentDialogIo(nextIo)
      setDialogQueue(prev => prev.slice(1)) // Remove from queue
      setShowValueChangeDialog(true)
      if (DEBUG_OTHER) {
        console.log('📋 Showing next dialog from queue:', nextIo.name, 'Remaining:', dialogQueue.length - 1)
      }
    } else if (!currentDialogIo && dialogQueue.length === 0) {
      // Close dialog when queue is empty
      setShowValueChangeDialog(false)
    }
  }, [dialogQueue, currentDialogIo, showFailCommentDialog, showFireOutputDialog])

  // Flush the batch buffer: if 1 item, use single dialog; if 2+, show batch dialog
  const addToDialogQueue = useCallback((io: IoItem) => {
    if (DEBUG_OTHER) {
      console.log('➕ Adding to dialog queue:', io.name)
    }

    setDialogQueue(prev => {
      // Check if this IO is already in queue (avoid duplicates)
      const isAlreadyInQueue = prev.some(queuedIo => queuedIo.id === io.id)
      if (isAlreadyInQueue) {
        if (DEBUG_OTHER) {
          console.log('⚠️ IO already in queue, skipping:', io.name)
        }
        return prev
      }
      const newQueue = [...prev, io]
      if (DEBUG_OTHER) {
        console.log('📋 Queue updated. Total waiting:', newQueue.length)
      }
      return newQueue
    })
  }, [])

  // Navigation handlers - removed back button since we go directly to testing page

  const handleSwitchSubsystem = async (subsystemId: number) => {
    try {
      // In a real implementation, this would:
      // 1. Update the backend configuration with the new subsystem ID
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
      const response = await fetchWithRetry(API_ENDPOINTS.status, { signal: AbortSignal.timeout(15000) })
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
          isTesting: updateTestingState
            ? (status.isTestingUsers && currentUserRef.current?.fullName
              ? (status.isTestingUsers as string[]).includes(currentUserRef.current.fullName)
              : (status.isTesting || false))
            : prev.isTesting
        }))
        
        if (DEBUG_OTHER) {
          console.log('✅ Loaded PLC config from backend:', status)
        }
      }
    } catch (error) {
      if (DEBUG_OTHER) {
        console.error('❌ Failed to load PLC config from backend:', error)
      }
    }
  }, [])

  // Track initialization to prevent duplicate calls from StrictMode or re-renders
  const isInitializedRef = useRef(false)

  // Load config and existing IOs on page mount (no PLC or SignalR connection)
  // No polling needed - SignalR provides real-time updates for state changes
  useEffect(() => {
    // Prevent duplicate initialization (React StrictMode runs effects twice)
    if (isInitializedRef.current) {
      return
    }
    isInitializedRef.current = true

    loadPlcConfig()
    loadIos()

    // Initial cloud status check (SSE will push live updates after this)
    fetch('/api/cloud/status')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setIsCloudConnected(data.connected === true) })
      .catch(() => setIsCloudConnected(false))

    return () => {
      isInitializedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]) // Only re-run when projectId changes

  // PlcCommunicationService is not used - real-time updates come via SignalR
  // PLC connection is managed by the backend, not the frontend

  // Use refs for frequently changing values to avoid re-registering SignalR handlers
  const plcStatusRef = useRef(plcStatus)
  const outputFiringInProgressRef = useRef(outputFiringInProgress)
  const previousStatesRef = useRef(previousStates)
  const currentUserRef = useRef(currentUser)

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

  useEffect(() => {
    currentUserRef.current = currentUser
  }, [currentUser])

  // Handle SignalR testing state changes
  useEffect(() => {
    const handleTestingStateChange = (newIsTesting: boolean, isTestingUsers?: string[]) => {
      const user = currentUserRef.current
      if (DEBUG_OTHER) {
        console.log('📡 WebSocket TestingStateChanged:', newIsTesting, 'users:', isTestingUsers, 'currentUser:', user?.fullName)
      }
      // Use ref to get current user (avoids stale closure)
      const userIsTesting = isTestingUsers && user?.fullName
        ? isTestingUsers.includes(user.fullName)
        : newIsTesting
      setPlcStatus(prev => ({
        ...prev,
        isTesting: userIsTesting
      }))
    }

    signalR.onTestingStateChange(handleTestingStateChange)

    return () => {
      signalR.offTestingStateChange(handleTestingStateChange)
    }
  }, [signalR.onTestingStateChange, signalR.offTestingStateChange])

  // Handle PLC connection changes (connect/disconnect broadcast)
  useEffect(() => {
    const handlePlcConnectionChange = (connected: boolean) => {
      if (DEBUG_OTHER) {
        console.log('📡 WebSocket PlcConnectionChanged:', connected)
      }
      setPlcStatus(prev => ({
        ...prev,
        isConnected: connected,
        isReconnecting: !connected && prev.isReconnecting,
      }))
      // Reload IOs and config when PLC connects
      if (connected) {
        loadPlcConfig(false)
      }
    }

    signalR.onPlcConnectionChange(handlePlcConnectionChange)
    return () => {
      signalR.offPlcConnectionChange(handlePlcConnectionChange)
    }
  }, [signalR.onPlcConnectionChange, signalR.offPlcConnectionChange])

  // Handle PLC network status (reconnecting indicator)
  useEffect(() => {
    const handleNetworkStatus = (update: { moduleName: string; status: string; reconnecting?: boolean }) => {
      if (update.moduleName === 'plc') {
        setPlcStatus(prev => ({
          ...prev,
          isConnected: update.status === 'online',
          isReconnecting: update.reconnecting ?? false,
        }))
      }
    }

    signalR.onNetworkStatusChange(handleNetworkStatus)
    return () => {
      signalR.offNetworkStatusChange(handleNetworkStatus)
    }
  }, [signalR.onNetworkStatusChange, signalR.offNetworkStatusChange])

  // Handle IOs updated (cloud pull from another device)
  useEffect(() => {
    const handleIOsUpdated = () => {
      if (DEBUG_OTHER) {
        console.log('📡 WebSocket IOsUpdated — reloading IO data')
      }
      loadIos()
    }

    signalR.onIOsUpdated(handleIOsUpdated)
    return () => {
      signalR.offIOsUpdated(handleIOsUpdated)
    }
  }, [signalR.onIOsUpdated, signalR.offIOsUpdated])

  // Handle cloud connection state changes via WebSocket (from SSE client)
  useEffect(() => {
    const handleCloudChange = (connected: boolean) => {
      setIsCloudConnected(connected)
    }
    signalR.onCloudConnectionChange(handleCloudChange)
    return () => {
      signalR.offCloudConnectionChange(handleCloudChange)
    }
  }, [signalR.onCloudConnectionChange, signalR.offCloudConnectionChange])

  // Handle SignalR comment updates
  useEffect(() => {
    const handleCommentUpdate = (update: CommentUpdate) => {
      if (DEBUG_OTHER) {
        console.log('📡 WebSocket CommentUpdate:', update)
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

      // Skip toast for WebSocket/SignalR retry messages — they spam during PLC init
      if ((event.source === 'websocket') && event.message.includes('connecting')) {
        return
      }

      // Show toast for errors and warnings
      if (event.severity === 'error') {
        toast({ title: event.message, variant: "destructive" })
      }
    }

    signalR.onError(handleError)

    return () => {
      signalR.offError(handleError)
    }
  }, [signalR.onError, signalR.offError])

  // Subscribe to tag status updates via WebSocket
  useEffect(() => {
    const handleTagStatusUpdate = (update: { totalTags: number; successfulTags: number; failedTags: number; hasErrors: boolean; connected: boolean }) => {
      setTagStatus(prev => ({
        ...prev,
        totalTags: update.totalTags,
        successfulTags: update.successfulTags,
        failedTags: update.failedTags,
        hasErrors: update.hasErrors,
      } as typeof prev))
    }

    signalR.onTagStatusUpdate(handleTagStatusUpdate)
    return () => {
      signalR.offTagStatusUpdate(handleTagStatusUpdate)
    }
  }, [signalR.onTagStatusUpdate, signalR.offTagStatusUpdate])

  // Re-fetch IOs when SignalR reconnects after a disconnect
  useEffect(() => {
    const handleReconnected = () => {
      if (DEBUG_OTHER) {
        console.log('🔄 WebSocket reconnected - re-fetching IOs to sync state')
      }
      loadIos()
    }

    signalR.onReconnected(handleReconnected)

    return () => {
      signalR.offReconnected(handleReconnected)
    }
  }, [signalR.onReconnected, signalR.offReconnected])

  // Track SignalR connected state for UI purposes (with debounce to avoid flashing on transient disconnects)
  const [showWsWarning, setShowWsWarning] = useState(false)
  const wsWarningTimer = useRef<NodeJS.Timeout | null>(null)
  useEffect(() => {
    if (signalR.isConnected) {
      setSignalRWasConnected(true)
      setShowWsWarning(false)
      if (wsWarningTimer.current) { clearTimeout(wsWarningTimer.current); wsWarningTimer.current = null }
    } else if (signalRWasConnected) {
      // Only show warning after 5 seconds of sustained disconnect
      wsWarningTimer.current = setTimeout(() => setShowWsWarning(true), 5000)
    }
    return () => { if (wsWarningTimer.current) clearTimeout(wsWarningTimer.current) }
  }, [signalR.isConnected, signalRWasConnected])

  // Auto-connect WebSocket when IOs are loaded (once)
  // This ensures real-time updates work without requiring explicit "Connect to PLC" button click
  const hasAutoConnectedRef = useRef(false)
  useEffect(() => {
    if (ios.length > 0 && !hasAutoConnectedRef.current) {
      hasAutoConnectedRef.current = true
      if (DEBUG_OTHER) {
        console.log('🔌 Auto-connecting WebSocket (IOs loaded)')
      }
      signalR.connect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ios.length]) // Only trigger on IOs loading, connect() is stable

  // Register SignalR handlers ALWAYS — not gated behind isConnected
  // This ensures handlers are ready BEFORE the connection delivers messages
  useEffect(() => {
    const handleIOUpdate = (update: IOUpdate) => {
      setIos(prevIos =>
        prevIos.map(io => {
          if (io.id === update.Id) {
            // Check if this is a state-only update (from continuous PLC reader via UpdateState)
            // or a full IO update (from result changes via UpdateIO)
            // State-only: Result='Not Tested', no timestamp, no comments — applies to ALL tags (inputs AND outputs)
            const isStateOnlyUpdate = update.Result === 'Not Tested' && !update.Timestamp && !update.Comments

            let updatedIo
            if (isStateOnlyUpdate) {
              // State-only update: only update the state, preserve result/timestamp/comments
              updatedIo = {
                ...io,
                state: update.State
              }
            } else {
              // Full IO update: update everything (result changes from Pass/Fail/Clear)
              updatedIo = {
                ...io,
                state: (update.State === 'TRUE' || update.State === 'FALSE') ? update.State : io.state,
                result: update.Result === "Not Tested" ? null : update.Result,
                timestamp: update.Timestamp || io.timestamp,
                comments: update.Comments !== undefined ? update.Comments : io.comments // Handle null comments explicitly
              }
              if (DEBUG_OTHER) {
                console.log('📡 Full IO update for:', io.name, 'New state:', update.State, 'New result:', updatedIo.result)
              }
            }

            // Use refs for current values to avoid dependency issues
            const currentPlcStatus = plcStatusRef.current
            const currentOutputFiring = outputFiringInProgressRef.current
            const currentPreviousStates = previousStatesRef.current

            // Check if we should show the value change dialog
            const stateActuallyChanged = currentPreviousStates[io.id] !== update.State
            const shouldShowDialog = currentPlcStatus.isTesting && !io.result && stateActuallyChanged && (
              // Show dialog on any FALSE→TRUE transition for both inputs and outputs
              // Inputs: physical sensor activation
              // Outputs: PLC program changed value, or user fired from UI
              update.State === 'TRUE'
            )

            if (shouldShowDialog) {
              // Skip dialog if IO is assigned to a different user
              const user = currentUserRef.current
              if (updatedIo.assignedTo && user?.fullName && updatedIo.assignedTo !== user.fullName) {
                // IO assigned to someone else — skip dialog for this user
              } else {
              if (DEBUG_OTHER) {
                console.log('💡 Triggering ValueChangeDialog for:', io.name, 'Type:', isOutput(io.name) ? 'OUTPUT' : 'INPUT', 'Current state:', update.State, 'Current result:', io.result)
              }
              // Add to queue instead of showing immediately
              addToDialogQueue(updatedIo)
              }
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
  }, [addToDialogQueue]) // Handlers registered once, use refs for mutable state

  const loadIos = async () => {
    try {
      // Only show full-page loading spinner on initial load (no IOs yet)
      if (ios.length === 0) setLoading(true)
      // Load IOs from backend (real PLC data) - retry on failure
      const response = await fetchWithRetry(API_ENDPOINTS.ios, { signal: AbortSignal.timeout(15000) })
      if (response.ok) {
        const data = await response.json()
        setIos(data)
        setFilteredIos(data)

        // Initialize previousStates ONLY on first load to prevent flood of dialogs
        // On subsequent reloads (auto-sync, cloud pull), keep existing previousStates
        // so that state change detection isn't reset (which would cause false dialog triggers)
        setPreviousStates(prev => {
          if (Object.keys(prev).length > 0) return prev  // Already initialized, keep existing
          const initialStates: Record<number, string> = {}
          for (const io of data as IoItem[]) {
            if (io.state) {
              initialStates[io.id] = io.state
            }
          }
          return initialStates
        })
        // Note: Don't auto-connect WebSocket here - only connect when PLC is connected
        // WebSocket is for real-time PLC tag updates, not needed for just viewing IOs

        // Restore dialog queue from localStorage (survives page refresh)
        try {
          const savedQueueIds = localStorage.getItem(DIALOG_QUEUE_STORAGE_KEY)
          if (savedQueueIds) {
            const ids = JSON.parse(savedQueueIds) as number[]
            const restoredQueue = (data as IoItem[]).filter(
              (io: IoItem) => ids.includes(io.id) && (!io.result || io.result === 'Not Tested')
            )
            if (restoredQueue.length > 0) {
              setDialogQueue(restoredQueue)
              if (DEBUG_OTHER) {
                console.log('📋 Restored dialog queue from localStorage:', restoredQueue.map((io: IoItem) => io.name))
              }
            }
            localStorage.removeItem(DIALOG_QUEUE_STORAGE_KEY)
          }
        } catch (e) {
          // Ignore localStorage errors
          localStorage.removeItem(DIALOG_QUEUE_STORAGE_KEY)
        }
      } else {
        logger.error('Failed to load IOs from backend:', response.status)
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

  const handleFireOutput = async (io: IoItem, action: 'start' | 'stop' | 'toggle') => {
    try {
      if (action === 'start' || action === 'toggle') {
        // Mark that output firing is in progress for this IO
        setOutputFiringInProgress(prev => ({ ...prev, [io.id]: true }))
      } else if (action === 'stop') {
        // Clear the firing flag after delay to allow SignalR update to arrive
        // Backend: 250ms delay + network latency. Use 3000ms for robustness.
        setTimeout(() => {
          setOutputFiringInProgress(prev => ({ ...prev, [io.id]: false }))
        }, 3000)
      }

      if (DEBUG_FIRE) {
        console.log(`🔥 Firing output ${action} for ${io.name}...`)
      }
      const response = await authFetch(API_ENDPOINTS.ioFireOutput(io.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      })

      if (response.ok) {
        const result = await response.json()
        if (DEBUG_FIRE) {
          console.log(`🔥 Output ${action} response for ${io.name}:`, result)
        }
        // Show warning if PLC write failed
        if (result.success === false && result.error) {
          toast({
            title: `Output write failed`,
            description: `${io.name}: ${result.error}. The output may not have changed.`,
            variant: 'destructive'
          })
        }

        // Update UI directly from API response (don't wait for WebSocket)
        if (result.success && result.state !== undefined) {
          const newState = result.state ? 'TRUE' : 'FALSE'
          setIos(prevIos =>
            prevIos.map(item =>
              item.id === io.id ? { ...item, state: newState } : item
            )
          )
        }
      } else {
        const errorText = await response.text()
        logger.error(`Failed to ${action} output:`, response.status, errorText)
        toast({
          title: `Failed to ${action} output`,
          description: `${io.name}: Server returned ${response.status}`,
          variant: 'destructive'
        })
      }
    } catch (error) {
      logger.error(`Error ${action}ing output:`, error)
      toast({
        title: `Error firing output`,
        description: `${io.name}: Network error`,
        variant: 'destructive'
      })
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

      if (DEBUG_OTHER) {
        console.log('Calling backend to mark IO as passed:', io.id, io.name)
      }
      const response = await authFetch(API_ENDPOINTS.ioPass(io.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          result: 'Pass',
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

      if (DEBUG_OTHER) {
        console.log('Calling backend to mark IO as failed:', io.id, io.name, comments, failureMode)
      }
      const response = await authFetch(API_ENDPOINTS.ioFail(io.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          result: 'Fail',
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
    // Save previous state for rollback
    const previousResult = io.result
    const previousComments = io.comments
    const previousTimestamp = io.timestamp

    try {
      // Optimistically update UI immediately
      setIos(prevIos => prevIos.map(i =>
        i.id === io.id ? { ...i, result: null, comments: null, timestamp: null } : i
      ))

      const response = await authFetch(API_ENDPOINTS.ioClear(io.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentUser: currentUser?.fullName || 'Unknown'
        })
      })

      if (response.ok) {
        if (DEBUG_OTHER) {
          console.log('✅ IO cleared via backend')
        }
      } else {
        logger.error('Failed to clear IO:', response.status)
        // Rollback optimistic update
        setIos(prevIos => prevIos.map(i =>
          i.id === io.id ? { ...i, result: previousResult, comments: previousComments, timestamp: previousTimestamp } : i
        ))
        toast({ title: "Failed to clear result", variant: "destructive" })
      }
    } catch (error) {
      logger.error('Error clearing IO:', error)
      // Rollback optimistic update
      setIos(prevIos => prevIos.map(i =>
        i.id === io.id ? { ...i, result: previousResult, comments: previousComments, timestamp: previousTimestamp } : i
      ))
      toast({ title: "Failed to clear result", description: "Network error", variant: "destructive" })
    }
  }


  const handleShowFireOutputDialog = (io: IoItem) => {
    setSelectedIo(io)
    setShowFireOutputDialog(true)
  }

  const handleValueChangeYes = (io: IoItem) => {
    // Mark as passed when user confirms the change
    if (DEBUG_OTHER) {
      console.log('🎯 Pass button clicked for:', io.name)
    }
    handleMarkPassed(io)
    // Clear current dialog and show next in queue
    setCurrentDialogIo(null)
  }

  const handleValueChangeNo = (io: IoItem) => {
    // Show comment dialog before marking as failed
    if (DEBUG_OTHER) {
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
    if (DEBUG_OTHER) {
      console.log('🎯 Marking as failed with comment:', io.name, comment, 'Failure mode:', failureMode)
    }
    handleMarkFailed(io, comment, failureMode)
    setPendingFailIo(null)
    // NOW clear currentDialogIo to advance the queue
    setCurrentDialogIo(null)
  }

  const handleFailCommentCancel = () => {
    // User cancelled the fail comment dialog - don't mark as failed
    if (DEBUG_OTHER) {
      console.log('🚫 Fail comment cancelled - not marking as failed')
    }
    setPendingFailIo(null)
    // NOW clear currentDialogIo to advance the queue
    setCurrentDialogIo(null)
  }

  const handleValueChangeCancel = (io: IoItem) => {
    // Do nothing, just close the dialog (no database update)
    if (DEBUG_OTHER) {
      console.log('🚫 Value change dialog cancelled for', io.name, '- No database update')
    }
    // Clear current dialog and show next in queue
    setCurrentDialogIo(null)
  }

  const handleClearAllDialogs = () => {
    // Clear all pending dialogs without marking any Pass/Fail
    if (DEBUG_OTHER) {
      console.log('🛑 Clearing all pending dialogs')
    }
    setDialogQueue([])
    setCurrentDialogIo(null)
    setPendingFailIo(null)
    setShowValueChangeDialog(false)
    setShowFailCommentDialog(false)
    localStorage.removeItem(DIALOG_QUEUE_STORAGE_KEY)
  }

  const handleCommentChange = async (io: IoItem, comment: string) => {
    try {
      // Optimistically update UI
      setIos(prevIos => prevIos.map(i =>
        i.id === io.id ? { ...i, comments: comment } : i
      ))

      if (DEBUG_OTHER) {
        console.log('💬 Updating comment for IO:', io.id, io.name, comment)
      }

      const response = await authFetch(API_ENDPOINTS.ioComment(io.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments: comment })
      })

      if (response.ok) {
        if (DEBUG_OTHER) {
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


  const handleCloudPull = async (newConfig: PlcConfig) => {
    logger.log('Cloud pull completed with config:', newConfig)
    setPlcConfig(newConfig)
    setShowConfigDialog(false)

    // Refetch IOs from backend (data should already be synced)
    await loadIos()

    // Update URL without navigation/remount (just for bookmarking)
    if (newConfig.subsystemId && newConfig.subsystemId !== params.id) {
      window.history.replaceState(null, '', `/commissioning/${newConfig.subsystemId}`)
    }

    // Do NOT connect SignalR - Pull IOs is a cloud download only
  }

  const handlePlcConnect = async (newConfig: PlcConfig) => {
    logger.log('PLC connect triggered with config:', newConfig)
    setPlcConfig(newConfig)

    // Connect SignalR for real-time PLC updates (IOs already loaded, no need to refetch)
    if (!signalR.isConnected) {
      signalR.connect()
    }
  }

  const handleTestConnection = async (): Promise<boolean> => {
    // Test connection via backend (real PLC communication)
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
      logger.error('backend connection test failed:', error)
      return false
    }
  }

  const handleToggleTesting = async () => {
    try {
      const response = await authFetch(API_ENDPOINTS.testingToggle, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: currentUser?.fullName })
      })

      if (response.ok) {
        const result = await response.json()
        logger.log('Testing toggled:', result.isTesting)

        // If testing is being turned OFF, clear all pending dialogs
        if (!result.isTesting) {
          setDialogQueue([])
          setCurrentDialogIo(null)
          setPendingFailIo(null)
          setShowValueChangeDialog(false)
          setShowFailCommentDialog(false)
          setShowFireOutputDialog(false)
          localStorage.removeItem(DIALOG_QUEUE_STORAGE_KEY)
          if (DEBUG_OTHER) {
            console.log('🛑 Testing stopped - cleared all pending dialogs')
          }
        }

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
    <ErrorBoundary>
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Compact Header Bar */}
      <header className="bg-card border-b flex-shrink-0 z-50">
        <div className="flex items-center justify-between px-2 sm:px-4 h-11 sm:h-12">
          <div className="flex items-center gap-2 sm:gap-4">
            <h1 className="text-sm sm:text-lg font-bold tracking-tight">IO CHECKOUT</h1>
            <div className="h-6 w-px bg-border hidden sm:block" />
            <span className="text-xs sm:text-sm font-mono bg-muted px-1.5 sm:px-2 py-0.5 rounded">
              SUB {plcConfig.subsystemId}
            </span>
            <div className="h-6 w-px bg-border" />
            <div className="flex bg-muted rounded p-0.5 gap-0.5">
              <button
                onClick={() => setActiveTab('io')}
                className={`px-2.5 sm:px-3 py-1 text-xs sm:text-sm font-medium rounded transition-colors ${
                  activeTab === 'io'
                    ? 'bg-background shadow text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                I/O Testing
              </button>
              <button
                onClick={() => setActiveTab('network')}
                className={`px-2.5 sm:px-3 py-1 text-xs sm:text-sm font-medium rounded transition-colors ${
                  activeTab === 'network'
                    ? 'bg-background shadow text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Network
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <UserMenu />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* SignalR Connection Warning - Shows when real-time updates are disconnected */}
      {showWsWarning && !signalR.isConnected && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-2 sm:px-4 py-1.5 sm:py-2 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
            <span className="text-xs sm:text-sm text-amber-600 dark:text-amber-400 font-medium">
              Reconnecting...
            </span>
          </div>
          <span className="text-xs text-amber-500/70 hidden sm:inline">
            PLC data may be stale
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

      {/* Tab Content */}
      {activeTab === 'network' ? (
        <div className="flex-1 min-h-0 overflow-auto">
          <NetworkTopologyView subsystemId={parseInt(plcConfig.subsystemId) || 16} />
        </div>
      ) : (
      <>
      {/* Main Toolbar - Full width */}
      <div className="flex-shrink-0">
        <PlcToolbar
          isTesting={plcStatus.isTesting}
          isPlcConnected={plcStatus.isConnected}
          isPlcReconnecting={plcStatus.isReconnecting}
          isCloudConnected={isCloudConnected}
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
          activeFilter={quickFilter}
          onFilterChange={setQuickFilter}
          tagStatus={tagStatus ? {
            totalTags: tagStatus.totalTags,
            successfulTags: tagStatus.successfulTags,
            failedTags: tagStatus.failedTags,
            hasErrors: tagStatus.hasErrors
          } : null}
          onShowTagStatus={() => setShowTagStatusDialog(true)}
          onShowChangeRequests={() => setShowChangeRequestsPanel(true)}
          onStartTour={() => setShowTour(true)}
          subsystemId={plcConfig.subsystemId}
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
            onShowFireOutputDialog={handleShowFireOutputDialog}
            onCommentChange={handleCommentChange}
            activeQuickFilter={quickFilter}
            onRequestChange={(io: IoItem) => {
              setChangeRequestIo(io)
              setShowChangeRequestDialog(true)
            }}
            currentUser={currentUser ? { fullName: currentUser.fullName, isAdmin: currentUser.isAdmin } : null}
          />
      </div>
      </>
      )}

      {/* Guided Tour */}
      <GuidedTour run={showTour} onFinish={() => setShowTour(false)} />

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
          onCloudPull={handleCloudPull}
          onPlcConnect={handlePlcConnect}
          onTestConnection={handleTestConnection}
        />

        {/* All Test History Dialog */}
        <AllTestHistoryDialog
          open={showHistoryDialog}
          onOpenChange={setShowHistoryDialog}
          projectId={projectId}
          projectName={`Project ${projectId}`}
        />


        {/* Fire Output Dialog - use current IO from array to get live state updates */}
        <FireOutputDialog
          open={showFireOutputDialog}
          onOpenChange={setShowFireOutputDialog}
          io={selectedIo ? ios.find(i => i.id === selectedIo.id) || selectedIo : null}
          onFireOutput={handleFireOutput}
        />

        {/* Value Change Dialog - use current IO from array to get live state updates */}
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
          io={currentDialogIo ? ios.find(i => i.id === currentDialogIo.id) || currentDialogIo : null}
          remainingCount={dialogQueue.length}
          onYes={handleValueChangeYes}
          onNo={handleValueChangeNo}
          onCancel={handleValueChangeCancel}
          onClearAll={handleClearAllDialogs}
          onStopTesting={plcStatus.isTesting ? handleToggleTesting : undefined}
        />

        {/* Fail Comment Dialog - use current IO from array to get live state updates */}
        <FailCommentDialog
          open={showFailCommentDialog}
          onOpenChange={setShowFailCommentDialog}
          io={pendingFailIo ? ios.find(i => i.id === pendingFailIo.id) || pendingFailIo : null}
          onSubmit={handleFailCommentSubmit}
          onCancel={handleFailCommentCancel}
        />

        {/* Cloud Sync Dialog */}
        <CloudSyncDialog
          open={showCloudSyncDialog}
          onOpenChange={setShowCloudSyncDialog}
          subsystemId={plcConfig.subsystemId}
        />

        {/* Tag Status Dialog */}
        <TagStatusDialog
          open={showTagStatusDialog}
          onOpenChange={setShowTagStatusDialog}
          tagStatus={tagStatus}
        />

        {/* Change Request Dialog */}
        <ChangeRequestDialog
          open={showChangeRequestDialog}
          onOpenChange={setShowChangeRequestDialog}
          io={changeRequestIo}
          currentUser={currentUser?.fullName}
        />

        {/* Change Requests Panel */}
        <ChangeRequestsPanel
          open={showChangeRequestsPanel}
          onOpenChange={setShowChangeRequestsPanel}
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
    </ErrorBoundary>
  )
}
