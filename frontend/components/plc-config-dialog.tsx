"use client"

import { useState, useEffect, useRef } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import * as VisuallyHidden from "@radix-ui/react-visually-hidden"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CloudDownload, Terminal, Cpu, Wifi, WifiOff, Copy, Check, Zap, Loader2 } from "lucide-react"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"
import type { PlcProfile } from "@/lib/config/types"

interface PlcConfig {
  ip: string
  path: string
  subsystemId: string
  apiPassword?: string
  remoteUrl?: string
}

interface PlcConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: PlcConfig
  onCloudPull: (config: PlcConfig) => void
  onPlcConnect: (config: PlcConfig) => void
  onTestConnection: () => Promise<boolean>
}

export function PlcConfigDialog({
  open,
  onOpenChange,
  config,
  onCloudPull,
  onPlcConnect,
  onTestConnection
}: PlcConfigDialogProps) {
  const [activeTab, setActiveTab] = useState<'subsystem' | 'cloud' | 'plc'>('cloud')
  const [profiles, setProfiles] = useState<PlcProfile[]>([])
  const [isSwitching, setIsSwitching] = useState(false)
  const [switchStatus, setSwitchStatus] = useState<string | null>(null)
  const [localConfig, setLocalConfig] = useState<PlcConfig>({
    ip: "", path: "", subsystemId: "", apiPassword: "", remoteUrl: ""
  })
  const [isPulling, setIsPulling] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isLoadingConfig, setIsLoadingConfig] = useState(false)

  const [pullStatus, setPullStatus] = useState<{ type: 'success' | 'error' | 'loading' | null; message: string }>({ type: null, message: '' })
  const [plcStatus, setPlcStatus] = useState<{ type: 'success' | 'error' | 'loading' | null; message: string }>({ type: null, message: '' })
  const [excludePatterns, setExcludePatterns] = useState('')

  const [pullLog, setPullLog] = useState<string[]>([])
  const [plcLog, setPlcLog] = useState<string[]>([])
  const [copied, setCopied] = useState(false)

  // Connection report for sharing with programmers
  const [connectionReport, setConnectionReport] = useState<{
    plcIp: string
    plcPath: string
    timestamp: string
    totalTags: number
    tagsSuccessful: number
    tagsFailed: number
    failedTags: Array<{ name: string; description?: string; error: string }>
  } | null>(null)

  const [pullElapsed, setPullElapsed] = useState(0)
  const [plcElapsed, setPlcElapsed] = useState(0)

  // Current live PLC status
  const [liveStatus, setLiveStatus] = useState<{
    plcConnected: boolean
    tagCount: number
    plcIp: string
  } | null>(null)
  const pullTimerRef = useRef<NodeJS.Timeout | null>(null)
  const plcTimerRef = useRef<NodeJS.Timeout | null>(null)
  const plcLogEndRef = useRef<HTMLDivElement | null>(null)
  const pullLogEndRef = useRef<HTMLDivElement | null>(null)
  const pollRef = useRef<NodeJS.Timeout | null>(null)
  const logSeqRef = useRef<number>(0)
  const pendingConnectConfigRef = useRef<PlcConfig | null>(null)

  const addPullLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setPullLog(prev => [...prev, `[${timestamp}] ${message}`])
  }

  const addPlcLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setPlcLog(prev => [...prev, `[${timestamp}] ${message}`])
  }

  // Auto-scroll logs
  useEffect(() => { plcLogEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [plcLog])
  useEffect(() => { pullLogEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [pullLog])

  // Timers
  useEffect(() => {
    if (pullStatus.type === 'loading') {
      setPullElapsed(0)
      pullTimerRef.current = setInterval(() => setPullElapsed(prev => prev + 1), 1000)
    } else {
      if (pullTimerRef.current) { clearInterval(pullTimerRef.current); pullTimerRef.current = null }
    }
    return () => { if (pullTimerRef.current) clearInterval(pullTimerRef.current) }
  }, [pullStatus.type])

  useEffect(() => {
    if (plcStatus.type === 'loading') {
      setPlcElapsed(0)
      plcTimerRef.current = setInterval(() => setPlcElapsed(prev => prev + 1), 1000)
    } else {
      if (plcTimerRef.current) { clearInterval(plcTimerRef.current); plcTimerRef.current = null }
    }
    return () => { if (plcTimerRef.current) clearInterval(plcTimerRef.current) }
  }, [plcStatus.type])

  // Cleanup poll on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  // Load config when dialog opens
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => loadActualConfig(), 100)
      return () => clearTimeout(timer)
    }
  }, [open])

  const loadActualConfig = async () => {
    if (isLoadingConfig) return
    try {
      setIsLoadingConfig(true)
      const response = await authFetch(API_ENDPOINTS.status)
      if (response.ok) {
        const status = await response.json()
        setLocalConfig({
          ip: status.plcIp || "",
          path: status.plcPath || "1,0",
          subsystemId: status.subsystemId || "",
          apiPassword: status.apiPassword || "",
          remoteUrl: status.remoteUrl || "https://commissioning.lci.ge"
        })
        // Set live status for showing connection state
        setLiveStatus({
          plcConnected: status.plcConnected || false,
          tagCount: status.tagCount || 0,
          plcIp: status.plcIp || ""
        })
        // If already connected, set success status
        if (status.plcConnected) {
          setPlcStatus({ type: 'success', message: `Connected to ${status.plcIp} (${status.tagCount} tags)` })
        }
        // Load PLC profiles (tab stays on 'cloud' by default)
        if (status.plcProfiles && Array.isArray(status.plcProfiles) && status.plcProfiles.length > 0) {
          setProfiles(status.plcProfiles)
        }
      }
    } catch (error) {
      console.error('Failed to load config:', error)
    } finally {
      setIsLoadingConfig(false)
    }
  }

  // ── Pull IOs from Cloud ──
  const handlePullIos = async () => {
    try {
      setIsPulling(true)
      setPullLog([])
      addPullLog(`Pull from ${localConfig.remoteUrl}`)
      addPullLog(`Subsystem ID: ${localConfig.subsystemId}`)
      setPullStatus({ type: 'loading', message: 'Connecting to cloud...' })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 120000)

      // Save cloud settings to config.json before pulling
      try {
        await authFetch(API_ENDPOINTS.configurationUpdate, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            remoteUrl: localConfig.remoteUrl || "",
            apiPassword: localConfig.apiPassword || "",
            subsystemId: localConfig.subsystemId,
          })
        })
      } catch (e) {
        console.warn('Failed to save config before pull:', e)
      }

      addPullLog('Sending request...')
      addPullLog(`API Password: ${localConfig.apiPassword ? `set (${localConfig.apiPassword.length} chars)` : 'NOT SET'}`)
      setPullStatus({ type: 'loading', message: `Fetching IOs for subsystem ${localConfig.subsystemId}...` })

      // Snapshot log sequence before pull
      try {
        const logRes = await authFetch(`${API_ENDPOINTS.configurationLogs}?afterId=0`)
        if (logRes.ok) {
          const logData = await logRes.json()
          const entries = logData.entries || []
          logSeqRef.current = entries.length > 0 ? entries[entries.length - 1].id : 0
        }
      } catch { /* ignore */ }

      const response = await authFetch(API_ENDPOINTS.cloudPull, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remoteUrl: localConfig.remoteUrl || "",
          apiPassword: localConfig.apiPassword || "",
          subsystemId: localConfig.subsystemId
        }),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      // Fetch backend logs that happened during the pull
      try {
        const logRes = await authFetch(`${API_ENDPOINTS.configurationLogs}?afterId=${logSeqRef.current}`)
        if (logRes.ok) {
          const logData = await logRes.json()
          for (const entry of (logData.entries || [])) {
            const time = new Date(entry.timestamp).toLocaleTimeString()
            addPullLog(`${entry.level}: ${entry.message}`)
            logSeqRef.current = entry.id
          }
        }
      } catch { /* ignore */ }

      addPullLog(`Response: ${response.status} ${response.statusText}`)

      if (response.ok) {
        const result = await response.json()
        addPullLog(`${result.ioCount || 0} IOs retrieved`)

        // ── Browser console: full pull breakdown ──
        console.log('[Pull] Full result:', JSON.stringify({
          ioCount: result.ioCount,
          networkPulled: result.networkPulled,
          estopPulled: result.estopPulled,
          punchlistsPulled: result.punchlistsPulled,
          l2Pulled: result.l2Pulled,
          l2CellsPulled: result.l2CellsPulled,
          historiesPulled: result.historiesPulled,
          l2Error: result.l2Error || null,
        }))

        // ── Browser console: FV-specific loud errors ──
        if (result.l2Error) {
          console.error('[Pull] FV/L2 ERROR:', result.l2Error)
        }
        if (result.l2Pulled === 0 && !result.l2Error) {
          console.warn('[Pull] FV/L2 WARNING: 0 devices pulled — no L2 template on cloud or empty response')
        }
        if (result.l2Pulled > 0) {
          console.log(`[Pull] FV/L2 OK: ${result.l2Pulled} devices, ${result.l2CellsPulled || 0} cell values`)
        }

        // Log all pull details so user can see what worked
        if (result.networkPulled !== undefined) addPullLog(`Network: ${result.networkPulled} rings`)
        if (result.estopPulled !== undefined) addPullLog(`E-Stop: ${result.estopPulled} zones`)
        if (result.punchlistsPulled !== undefined) addPullLog(`Punchlists: ${result.punchlistsPulled}`)
        if (result.historiesPulled !== undefined) addPullLog(`Test histories: ${result.historiesPulled}`)

        // L2/FV pull status — make it very visible
        if (result.l2Pulled !== undefined) {
          addPullLog(`FV (L2): ${result.l2Pulled} devices, ${result.l2CellsPulled || 0} cell values`)
          if (result.l2Pulled === 0) {
            addPullLog('WARNING: No FV data pulled — check if L2 template is configured on cloud')
          }
        }
        if (result.l2Error) {
          addPullLog(`FV ERROR: ${result.l2Error}`)
        }
        if (result.warning) {
          addPullLog(`WARNING: ${result.warning}`)
        }

        if (result.ioCount === 0) {
          addPullLog('No IOs found - check subsystem ID')
          setPullStatus({ type: 'error', message: `No IOs found for subsystem ${localConfig.subsystemId}` })
        } else {
          const l2Note = result.l2Pulled > 0 ? `, ${result.l2Pulled} FV devices` : ''
          setPullStatus({ type: 'success', message: `Pulled ${result.ioCount} IOs${l2Note}` })
          onCloudPull(localConfig)
        }
      } else if (response.status === 409) {
        // Pending local queues block pull so cloud cannot overwrite unsynced site data.
        let errorData: any = {}
        try { errorData = await response.json() } catch {}
        const msg = errorData.error || 'Unsynced test results exist'
        addPullLog(`BLOCKED: ${msg}`)
        addPullLog('Attempting to sync pending results first...')
        setPullStatus({ type: 'loading', message: 'Syncing pending results...' })

        // Try to sync first, then retry pull
        try {
          const syncRes = await authFetch(API_ENDPOINTS.cloudSync, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              remoteUrl: localConfig.remoteUrl,
              apiPassword: localConfig.apiPassword,
            }),
          })
          if (syncRes.ok) {
            const syncResult = await syncRes.json()
            addPullLog(`Synced ${syncResult.syncedCount} results to cloud`)

            // Retry pull normally. If anything is still pending, keep blocking instead of overwriting local data.
            addPullLog('Retrying pull...')
            const retryRes = await authFetch(API_ENDPOINTS.cloudPull, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                remoteUrl: localConfig.remoteUrl || "",
                apiPassword: localConfig.apiPassword || "",
                subsystemId: localConfig.subsystemId,
              }),
            })
            if (retryRes.ok) {
              const retryResult = await retryRes.json()
              addPullLog(`Pulled ${retryResult.ioCount} IOs`)
              if (retryResult.l2Pulled !== undefined) addPullLog(`FV (L2): ${retryResult.l2Pulled} devices, ${retryResult.l2CellsPulled || 0} cells`)
              if (retryResult.l2Pulled === 0) addPullLog('WARNING: No FV data pulled')
              if (retryResult.l2Error) addPullLog(`FV ERROR: ${retryResult.l2Error}`)

              const l2Note = retryResult.l2Pulled > 0 ? `, ${retryResult.l2Pulled} FV devices` : ''
              setPullStatus({ type: 'success', message: `Synced & pulled ${retryResult.ioCount} IOs${l2Note}` })
              onCloudPull(localConfig)
            } else {
              setPullStatus({ type: 'error', message: 'Pull failed after sync' })
            }
            } else {
              addPullLog('Sync failed — pull aborted to protect local unsynced data')
              setPullStatus({ type: 'error', message: 'Pull blocked until pending local changes are synced' })
            }
        } catch (syncErr: any) {
          addPullLog(`Sync attempt failed: ${syncErr.message}`)
          setPullStatus({ type: 'error', message: msg })
        }
      } else {
        let errorMsg = ''
        try {
          const errorText = await response.text()
          try {
            const errorData = JSON.parse(errorText)
            errorMsg = errorData.message || errorData.error || errorText
          } catch {
            errorMsg = errorText || response.statusText
          }
        } catch {
          errorMsg = response.statusText
        }
        addPullLog(`ERROR: ${response.status} - ${errorMsg}`)
        setPullStatus({ type: 'error', message: errorMsg })
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        addPullLog('Timed out after 2 minutes')
        setPullStatus({ type: 'error', message: 'Request timed out' })
      } else {
        addPullLog(`ERROR: ${error.message}`)
        setPullStatus({ type: 'error', message: error.message })
      }
    } finally {
      setIsPulling(false)
    }
  }

  // ── Connect to PLC ──
  const handlePlcConnect = async () => {
    try {
      setIsConnecting(true)
      setPlcLog([])
      addPlcLog(`Config: IP=${localConfig.ip}, Path=${localConfig.path}`)
      addPlcLog(`Subsystem: ${localConfig.subsystemId}`)
      if (excludePatterns.trim()) {
        addPlcLog(`Excluding tags: ${excludePatterns}`)
      }
      setPlcStatus({ type: 'loading', message: 'Saving configuration...' })

      // Always use lightweight PLC-only connect endpoint
      // The full configurationUpdate endpoint triggers cloud sync and full reinitialization
      const endpoint = API_ENDPOINTS.configurationConnectPlc

      addPlcLog('Connecting to PLC...')

      const response = await authFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: localConfig.ip,
          path: localConfig.path,
          subsystemId: localConfig.subsystemId,
          apiPassword: localConfig.apiPassword || "",
          remoteUrl: localConfig.remoteUrl || "",
          excludePatterns: excludePatterns.trim() || null
        })
      })

      // Parse response — now always 200, check success field
      const connectData = await response.json().catch(() => null)

      if (!response.ok) {
        // True server error (not tag mismatch)
        addPlcLog(`ERROR: ${connectData?.error || response.statusText}`)
        setPlcStatus({ type: 'error', message: connectData?.error || 'Server error' })
        setIsConnecting(false)
        return
      }

      // Store the connection report for the "Copy Report" feature
      const failedTags: Array<{ name: string; description?: string; error: string }> = connectData?.failedTags || []
      if (connectData?.tagsFailed > 0) {
        setConnectionReport({
          plcIp: localConfig.ip,
          plcPath: localConfig.path,
          timestamp: connectData.timestamp || new Date().toISOString(),
          totalTags: connectData.totalTags || 0,
          tagsSuccessful: connectData.tagsSuccessful || 0,
          tagsFailed: connectData.tagsFailed || 0,
          failedTags,
        })
      }

      // Connection returned but failed
      if (connectData?.success === false) {
        const plcReachable = connectData.plcReachable === true

        if (!plcReachable) {
          // PLC is not reachable at all
          addPlcLog(`ERROR: Cannot reach PLC at ${localConfig.ip}`)
          addPlcLog('Check:')
          addPlcLog('  1. Is the PLC IP address correct?')
          addPlcLog('  2. Is the PLC powered on and on the network?')
          addPlcLog('  3. Can this machine reach the PLC network?')
          addPlcLog('  4. Is the PLC path (slot) correct?')
          setPlcStatus({ type: 'error', message: `PLC not reachable at ${localConfig.ip}` })
        } else {
          // PLC is reachable but tags don't match
          addPlcLog(`PLC connected at ${localConfig.ip} — but tags do not match.`)
          addPlcLog(`Tags: ${connectData.tagsSuccessful || 0}/${connectData.totalTags || 0} OK${connectData.tagsFailed > 0 ? `, ${connectData.tagsFailed} failed` : ''}`)

          if (failedTags.length > 0) {
            addPlcLog('---')
            addPlcLog(`MISMATCH REPORT — ${failedTags.length} tags not found on PLC:`)
            for (const tag of failedTags.slice(0, 40)) {
              addPlcLog(`  ✗ ${tag.name}${tag.description ? ` (${tag.description})` : ''}  →  ${tag.error}`)
            }
            if (failedTags.length > 40) {
              addPlcLog(`  ... and ${failedTags.length - 40} more`)
            }
            addPlcLog('---')
            addPlcLog('Tag names pulled from cloud do not match the PLC program.')
            addPlcLog('Use "Copy Report" to share with the PLC programmer.')
          }
          setPlcStatus({ type: 'error', message: `${connectData.tagsFailed} of ${connectData.totalTags} tags failed` })
        }
        setIsConnecting(false)
        return
      }

      // Success path
      addPlcLog(`Connected to PLC at ${localConfig.ip}`)

      if (connectData?.warning) {
        addPlcLog(`⚠ ${connectData.warning}`)
        if (failedTags.length > 0) {
          for (const tag of failedTags.slice(0, 20)) {
            addPlcLog(`  ✗ ${tag.name}${tag.description ? ` (${tag.description})` : ''}  →  ${tag.error}`)
          }
          if (failedTags.length > 20) {
            addPlcLog(`  ... and ${failedTags.length - 20} more`)
          }
          addPlcLog('Use "Copy Report" to share with the PLC programmer.')
        }
      }

      setPlcStatus({ type: 'loading', message: `Connecting to ${localConfig.ip}...` })

      // Snapshot current log sequence so we only show new entries
      try {
        const logRes = await authFetch(`${API_ENDPOINTS.configurationLogs}?afterId=0`)
        if (logRes.ok) {
          const logData = await logRes.json()
          const entries = logData.entries || []
          logSeqRef.current = entries.length > 0 ? entries[entries.length - 1].id : 0
        }
      } catch { /* ignore */ }

      // Poll backend status + logs for PLC connection result
      let attempts = 0
      const maxAttempts = 120

      // Clear any existing poll
      if (pollRef.current) clearInterval(pollRef.current)

      pollRef.current = setInterval(async () => {
        attempts++
        try {
          // Fetch backend logs
          try {
            const logRes = await authFetch(`${API_ENDPOINTS.configurationLogs}?afterId=${logSeqRef.current}`)
            if (logRes.ok) {
              const logData = await logRes.json()
              const entries = logData.entries || []
              for (const entry of entries) {
                const time = new Date(entry.timestamp).toLocaleTimeString()
                const msg = `[${time}] ${entry.level}: ${entry.message}`
                setPlcLog(prev => [...prev, msg])
                logSeqRef.current = entry.id
              }
            }
          } catch { /* ignore log fetch errors */ }

          // Check PLC status
          const statusRes = await authFetch(API_ENDPOINTS.status)
          if (statusRes.ok) {
            const status = await statusRes.json()

            if (status.plcConnected) {
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
              addPlcLog(`PLC connected!`)
              if (status.tagCount > 0 && status.totalIos > 0) {
                addPlcLog(`${status.tagCount}/${status.totalIos} tags active`)
                if (status.tagCount < status.totalIos) {
                  addPlcLog(`⚠ ${status.totalIos - status.tagCount} tags failed — check tag names match PLC program`)
                }
              } else if (status.totalIos > 0) {
                addPlcLog(`${status.totalIos} IOs in database`)
              }
              setPlcStatus({ type: 'success', message: `Connected to PLC at ${localConfig.ip}` })
              setLiveStatus({
                plcConnected: true,
                tagCount: status.tagCount || status.totalIos || 0,
                plcIp: localConfig.ip
              })
              setIsConnecting(false)
              addPlcLog('Close this dialog to start testing.')
              pendingConnectConfigRef.current = localConfig
              return
            }
          }
        } catch { /* ignore poll errors */ }

        if (attempts >= maxAttempts) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          addPlcLog('---')
          addPlcLog('PLC connection timed out after 120s')
          addPlcLog('Possible causes:')
          addPlcLog('  - PLC is not powered on')
          addPlcLog('  - Wrong IP address')
          addPlcLog('  - Not on the same network/VLAN')
          addPlcLog('  - Firewall blocking port 44818')
          addPlcLog('  - Wrong communication path')
          addPlcLog('---')
          addPlcLog('Config was saved. You can retry or check network.')
          setPlcStatus({ type: 'error', message: `PLC not reachable at ${localConfig.ip}` })
          setIsConnecting(false)
          pendingConnectConfigRef.current = localConfig
        }
      }, 1000)
    } catch (error: any) {
      addPlcLog(`ERROR: ${error.message}`)
      setPlcStatus({ type: 'error', message: error.message })
      setIsConnecting(false)
    }
  }

  // ── Cancel connection attempt ──
  const handleCancelConnect = () => {
    // Stop any ongoing poll
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    setIsConnecting(false)
    addPlcLog('Connection attempt cancelled')
    setPlcStatus({ type: null, message: '' })
  }

  // ── Disconnect PLC ──
  const handleDisconnect = async () => {
    // Stop any ongoing poll
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }

    try {
      setIsDisconnecting(true)
      setIsConnecting(false)
      addPlcLog('Disconnecting...')
      setPlcStatus({ type: 'loading', message: 'Disconnecting...' })

      const response = await authFetch(API_ENDPOINTS.plcDisconnect, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      if (response.ok) {
        addPlcLog('PLC disconnected')
        setPlcStatus({ type: 'success', message: 'Disconnected' })
        setLiveStatus(prev => prev ? { ...prev, plcConnected: false, tagCount: 0 } : null)
      } else {
        const error = await response.text()
        addPlcLog(`Disconnect failed: ${error}`)
        setPlcStatus({ type: 'error', message: error || response.statusText })
      }
    } catch (error: any) {
      addPlcLog(`ERROR: ${error.message}`)
      setPlcStatus({ type: 'error', message: error.message })
    } finally {
      setIsDisconnecting(false)
    }
  }

  const busy = isPulling || isConnecting || isDisconnecting

  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (!busy) {
        if (!v && pendingConnectConfigRef.current) {
          onPlcConnect(pendingConnectConfigRef.current)
          pendingConnectConfigRef.current = null
        }
        onOpenChange(v)
      }
    }}>
      <DialogContent className="max-w-2xl h-[90vh] sm:h-[80vh] flex flex-col border-2 border-primary/20 p-0 gap-0 w-[95vw] sm:w-auto" aria-describedby={undefined}>
        <VisuallyHidden.Root>
          <DialogTitle>PLC Configuration</DialogTitle>
        </VisuallyHidden.Root>
        {/* Tabs */}
        <div className="flex border-b">
          {profiles.length > 0 && (
            <button
              onClick={() => setActiveTab('subsystem')}
              className={`flex-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                activeTab === 'subsystem'
                  ? 'border-b-2 border-orange-500 text-orange-600 bg-orange-50/50 dark:bg-orange-950/20'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              <Zap className="w-4 h-4" />
              Subsystem
            </button>
          )}
          <button
            onClick={() => setActiveTab('cloud')}
            className={`flex-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
              activeTab === 'cloud'
                ? 'border-b-2 border-primary text-primary bg-primary/5 dark:bg-primary/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <CloudDownload className="w-4 h-4" />
            Cloud Data
            {pullStatus.type === 'loading' && <div className="animate-spin h-3 w-3 border-2 border-primary border-t-transparent rounded-full" />}
            {pullStatus.type === 'success' && <span className="w-2 h-2 rounded-full bg-green-500" />}
            {pullStatus.type === 'error' && <span className="w-2 h-2 rounded-full bg-red-500" />}
          </button>
          <button
            onClick={() => setActiveTab('plc')}
            className={`flex-1 px-4 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
              activeTab === 'plc'
                ? 'border-b-2 border-green-500 text-green-600 bg-green-50/50 dark:bg-green-950/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <Cpu className="w-4 h-4" />
            PLC Connection
            {plcStatus.type === 'loading' && <div className="animate-spin h-3 w-3 border-2 border-green-500 border-t-transparent rounded-full" />}
            {plcStatus.type === 'success' && <span className="w-2 h-2 rounded-full bg-green-500" />}
            {plcStatus.type === 'error' && <span className="w-2 h-2 rounded-full bg-red-500" />}
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* ═══ SUBSYSTEM TAB ═══ */}
          {activeTab === 'subsystem' && (
            <div className="flex-1 flex flex-col p-4 gap-4 overflow-auto">
              <div>
                <h3 className="text-sm font-semibold mb-1">Select Subsystem</h3>
                <p className="text-xs text-muted-foreground">Choose a subsystem to auto-configure PLC connection and pull IOs.</p>
              </div>

              {switchStatus && (
                <div className={`text-sm px-3 py-2 rounded-md ${switchStatus.includes('Error') || switchStatus.includes('Failed') ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400' : 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400'}`}>
                  {switchStatus}
                </div>
              )}

              <div className="grid gap-2">
                {profiles.map((profile) => {
                  const isActive = localConfig.subsystemId === profile.subsystemId && localConfig.ip === profile.plcIp
                  return (
                    <button
                      key={profile.name}
                      disabled={isSwitching}
                      onClick={async () => {
                        setIsSwitching(true)
                        setSwitchStatus(null)
                        try {
                          // 1. Switch config
                          setSwitchStatus(`Switching to ${profile.name}...`)
                          const switchRes = await authFetch('/api/configuration/switch-subsystem', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              profileName: profile.name,
                              subsystemId: profile.subsystemId,
                              plcIp: profile.plcIp,
                              plcPath: profile.plcPath,
                            }),
                          })
                          if (!switchRes.ok) throw new Error('Failed to switch config')

                          // 2. Pull IOs
                          setSwitchStatus(`Pulling IOs for ${profile.name}...`)
                          const pullRes = await authFetch(API_ENDPOINTS.cloudPull, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              remoteUrl: localConfig.remoteUrl,
                              apiPassword: localConfig.apiPassword,
                              subsystemId: profile.subsystemId,
                            }),
                          })
                          const pullData = await pullRes.json()
                          if (!pullRes.ok) throw new Error(pullData.error || 'Pull failed')

                          // 3. Connect PLC
                          setSwitchStatus(`Connecting to PLC at ${profile.plcIp}...`)
                          const connectRes = await authFetch(API_ENDPOINTS.plcConnect, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              ip: profile.plcIp,
                              path: profile.plcPath,
                              subsystemId: profile.subsystemId,
                            }),
                          })
                          if (!connectRes.ok) throw new Error('PLC connection failed')

                          // Update local state
                          setLocalConfig(prev => ({ ...prev, ip: profile.plcIp, path: profile.plcPath, subsystemId: profile.subsystemId }))
                          setLiveStatus({ plcConnected: true, tagCount: pullData.count || 0, plcIp: profile.plcIp })
                          setSwitchStatus(`${profile.name} ready — ${pullData.count || 0} IOs loaded, PLC connected`)

                          // Notify parent
                          onPlcConnect({ ...localConfig, ip: profile.plcIp, path: profile.plcPath, subsystemId: profile.subsystemId })
                        } catch (error) {
                          setSwitchStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
                        } finally {
                          setIsSwitching(false)
                        }
                      }}
                      className={`text-left p-4 rounded-lg border-2 transition-all ${
                        isActive
                          ? 'border-green-500 bg-green-50/50 dark:bg-green-950/20'
                          : 'border-border hover:border-primary/50 hover:bg-muted/50'
                      } ${isSwitching ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-semibold text-sm">{profile.name}</div>
                          <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                            PLC: {profile.plcIp} · Path: {profile.plcPath} · Sub: {profile.subsystemId}
                          </div>
                        </div>
                        {isActive && <span className="text-xs font-medium text-green-600 dark:text-green-400 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" /> Active</span>}
                        {isSwitching && localConfig.subsystemId !== profile.subsystemId && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                      </div>
                    </button>
                  )
                })}
              </div>

              {profiles.length === 0 && (
                <div className="text-center text-sm text-muted-foreground py-8">
                  No subsystem profiles configured. Add <code>plcProfiles</code> to <code>config.json</code>.
                </div>
              )}
            </div>
          )}

          {/* ═══ CLOUD TAB ═══ */}
          {activeTab === 'cloud' && (
            <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="subsystemId" className="text-xs">Subsystem ID</Label>
                    <Input
                      id="subsystemId"
                      value={localConfig.subsystemId}
                      onChange={(e) => setLocalConfig({ ...localConfig, subsystemId: e.target.value })}
                      placeholder="16"
                      disabled={busy}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="sm:col-span-2 space-y-1">
                    <Label htmlFor="remoteUrl" className="text-xs">Remote URL</Label>
                    <Input
                      id="remoteUrl"
                      value={localConfig.remoteUrl || ""}
                      onChange={(e) => setLocalConfig({ ...localConfig, remoteUrl: e.target.value })}
                      placeholder="https://your-cloud-service.com"
                      disabled={busy}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="apiPassword" className="text-xs">API Password</Label>
                  <Input
                    id="apiPassword"
                    type="text"
                    value={localConfig.apiPassword || ""}
                    onChange={(e) => setLocalConfig({ ...localConfig, apiPassword: e.target.value })}
                    placeholder="Project API password"
                    disabled={busy}
                    className="h-8 text-sm"
                  />
                </div>

                <Button
                  onClick={handlePullIos}
                  disabled={busy || !localConfig.subsystemId || !localConfig.remoteUrl}
                  className="w-full bg-primary hover:bg-primary/90 text-white h-10"
                >
                  <CloudDownload className="w-4 h-4 mr-2" />
                  {isPulling ? `Pulling... (${pullElapsed}s)` : "Pull IOs from Cloud"}
                </Button>

                {/* Status */}
                {pullStatus.type && (
                  <div className={`px-3 py-2 rounded-md text-sm font-medium ${
                    pullStatus.type === 'loading' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200' :
                    pullStatus.type === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200' :
                    'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
                  }`}>
                    <div className="flex items-center gap-2">
                      {pullStatus.type === 'loading' && <div className="animate-spin h-3.5 w-3.5 border-2 border-current border-t-transparent rounded-full" />}
                      <span>{pullStatus.message}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Log takes remaining space */}
              {pullLog.length > 0 && (
                <div className="flex-1 min-h-0 rounded border bg-black/95 dark:bg-black flex flex-col overflow-hidden">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium text-green-400 uppercase tracking-wider border-b border-gray-800">
                    <Terminal className="w-3 h-3" />
                    Log
                  </div>
                  <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-0.5">
                    {pullLog.map((log, i) => (
                      <div key={i} className={
                        log.includes('ERROR') || log.includes('failed') ? 'text-red-400' :
                        log.includes('retrieved') || log.includes('Success') || log.includes('Pulled') ? 'text-green-400' :
                        'text-gray-400'
                      }>{log}</div>
                    ))}
                    <div ref={pullLogEndRef} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ PLC TAB ═══ */}
          {activeTab === 'plc' && (
            <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
              <div className="space-y-3">
                {/* Current Connection Status Banner */}
                {liveStatus && (
                  <div className={`px-3 py-2.5 rounded-lg border-2 ${
                    liveStatus.plcConnected
                      ? 'bg-green-50 dark:bg-green-950/30 border-green-500/50'
                      : 'bg-gray-50 dark:bg-gray-900/50 border-gray-300 dark:border-gray-700'
                  }`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full ${
                          liveStatus.plcConnected ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
                        }`} />
                        <span className={`text-sm font-medium ${
                          liveStatus.plcConnected ? 'text-green-700 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'
                        }`}>
                          {liveStatus.plcConnected
                            ? `Connected to ${liveStatus.plcIp}`
                            : 'Not connected'}
                        </span>
                      </div>
                      {liveStatus.plcConnected && (
                        <span className="text-xs text-green-600 dark:text-green-500 font-mono">
                          {liveStatus.tagCount} tags
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="ip" className="text-xs">PLC IP Address</Label>
                    <Input
                      id="ip"
                      value={localConfig.ip}
                      onChange={(e) => setLocalConfig({ ...localConfig, ip: e.target.value })}
                      placeholder="192.168.1.100"
                      disabled={busy}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="path" className="text-xs">Communication Path</Label>
                    <Input
                      id="path"
                      value={localConfig.path}
                      onChange={(e) => setLocalConfig({ ...localConfig, path: e.target.value })}
                      placeholder="1,0"
                      disabled={busy}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="excludePatterns" className="text-xs">Skip Tags Containing (comma-separated)</Label>
                  <Input
                    id="excludePatterns"
                    value={excludePatterns}
                    onChange={(e) => setExcludePatterns(e.target.value)}
                    placeholder="NCP1_4A_VFD, Spare_, Offline_"
                    disabled={busy}
                    className="h-8 text-sm font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground">Tags matching these patterns will be skipped during validation (saves time for offline modules)</p>
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={handlePlcConnect}
                    disabled={busy || !localConfig.ip}
                    className={`flex-1 h-10 ${
                      liveStatus?.plcConnected
                        ? 'bg-primary hover:bg-primary/90 text-white'
                        : 'bg-green-600 hover:bg-green-700 text-white'
                    }`}
                  >
                    <Wifi className="w-4 h-4 mr-2" />
                    {isConnecting
                      ? `Connecting... (${plcElapsed}s)`
                      : liveStatus?.plcConnected
                        ? "Reconnect"
                        : "Connect to PLC"}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={isConnecting ? handleCancelConnect : handleDisconnect}
                    disabled={isDisconnecting || isPulling || (!liveStatus?.plcConnected && !isConnecting)}
                    className="min-w-[120px] h-10"
                  >
                    <WifiOff className="w-4 h-4 mr-2" />
                    {isDisconnecting ? "..." : isConnecting ? "Cancel" : "Disconnect"}
                  </Button>
                </div>

                {/* Status */}
                {plcStatus.type && (
                  <div className={`px-3 py-2 rounded-md text-sm font-medium ${
                    plcStatus.type === 'loading' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200' :
                    plcStatus.type === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200' :
                    'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
                  }`}>
                    <div className="flex items-center gap-2">
                      {plcStatus.type === 'loading' && <div className="animate-spin h-3.5 w-3.5 border-2 border-current border-t-transparent rounded-full" />}
                      <span>{plcStatus.message}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Log takes remaining space */}
              <div className="flex-1 min-h-0 rounded border bg-black/95 dark:bg-black flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-green-400 uppercase tracking-wider">
                    <Terminal className="w-3 h-3" />
                    PLC Log
                  </div>
                  {connectionReport && connectionReport.tagsFailed > 0 && (
                    <button
                      onClick={() => {
                        const report = [
                          `PLC Tag Mismatch Report`,
                          `========================`,
                          `PLC IP: ${connectionReport.plcIp}`,
                          `PLC Path: ${connectionReport.plcPath}`,
                          `Date: ${new Date(connectionReport.timestamp).toLocaleString()}`,
                          ``,
                          `Total Tags: ${connectionReport.totalTags}`,
                          `Successful: ${connectionReport.tagsSuccessful}`,
                          `Failed: ${connectionReport.tagsFailed}`,
                          ``,
                          `Failed Tags:`,
                          ...connectionReport.failedTags.map(t => `  ✗ ${t.name}${t.description ? ` (${t.description})` : ''}  →  ${t.error}`),
                        ].join('\n')
                        navigator.clipboard.writeText(report)
                        setCopied(true)
                        setTimeout(() => setCopied(false), 2000)
                      }}
                      className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
                    >
                      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                      {copied ? 'Copied!' : 'Copy Report'}
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-0.5">
                  {plcLog.length === 0 ? (
                    <div className="text-gray-600">Waiting for connection...</div>
                  ) : (
                    plcLog.map((log, i) => (
                      <div key={i} className={
                        log.includes('✗') ? 'text-yellow-400 pl-2' :
                        log.includes('MISMATCH') || log.includes('do not match') ? 'text-red-400 font-semibold' :
                        log.includes('ERROR') || log.includes('failed') || log.includes('timed out') || log.includes('not reachable') ? 'text-red-400' :
                        log.includes('Connected') || log.includes('saved') || log.includes('loaded') || log.includes('Disconnected') ? 'text-green-400' :
                        log.startsWith('[') ? 'text-gray-400' :
                        'text-gray-500'
                      }>{log}</div>
                    ))
                  )}
                  <div ref={plcLogEndRef} />
                </div>
              </div>
            </div>
          )}

        </div>
      </DialogContent>
    </Dialog>
  )
}
