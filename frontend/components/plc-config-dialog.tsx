"use client"

import { useState, useEffect, useRef } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TestTube, Unplug, CloudDownload, Terminal } from "lucide-react"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"

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
  onConfigChange: (config: PlcConfig) => void
  onTestConnection: () => Promise<boolean>
}

export function PlcConfigDialog({
  open,
  onOpenChange,
  config,
  onConfigChange,
  onTestConnection
}: PlcConfigDialogProps) {
  const [localConfig, setLocalConfig] = useState<PlcConfig>({
    ip: "",
    path: "",
    subsystemId: "",
    apiPassword: "",
    remoteUrl: ""
  })
  const [isSaving, setIsSaving] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isPulling, setIsPulling] = useState(false)
  const [isLoadingConfig, setIsLoadingConfig] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error' | 'loading' | null; message: string }>({ type: null, message: '' })
  const [activityLog, setActivityLog] = useState<string[]>([])
  const [elapsedTime, setElapsedTime] = useState(0)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  // Helper to add log entry
  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setActivityLog(prev => [...prev.slice(-9), `[${timestamp}] ${message}`])
    console.log(`[PLC Config] ${message}`)
  }

  // Start/stop elapsed timer when loading
  useEffect(() => {
    if (saveStatus.type === 'loading') {
      setElapsedTime(0)
      timerRef.current = setInterval(() => {
        setElapsedTime(prev => prev + 1)
      }, 1000)
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [saveStatus.type])

  // Load actual config from C# backend when dialog opens
  useEffect(() => {
    if (open) {
      // Add a small delay to prevent rapid successive calls
      const timer = setTimeout(() => {
        loadActualConfig()
      }, 100)
      
      return () => clearTimeout(timer)
    }
  }, [open])

  const loadActualConfig = async () => {
    if (isLoadingConfig) {
      console.log('⏳ Config already loading, skipping...')
      return
    }
    
    try {
      setIsLoadingConfig(true)
      console.log('🔄 Loading actual config from C# backend...')
      const response = await authFetch(API_ENDPOINTS.status)
      if (response.ok) {
        const status = await response.json()
        console.log('📡 Raw status response from C# backend:', status)
        
        const actualConfig: PlcConfig = {
          ip: status.plcIp || "192.168.20.14",
          path: status.plcPath || "1,1",
          subsystemId: status.subsystemId || "16",
          apiPassword: status.apiPassword || "",
          remoteUrl: status.remoteUrl || ""
        }
        setLocalConfig(actualConfig)
        
        console.log('✅ Loaded actual config from C# backend:', actualConfig)
      } else {
        console.error('❌ Failed to get status from C# backend:', response.status, response.statusText)
      }
    } catch (error) {
      console.error('❌ Failed to load actual config from C# backend:', error)
    } finally {
      setIsLoadingConfig(false)
    }
  }

  const handleSave = async () => {
    try {
      setIsSaving(true)
      setSaveStatus({ type: 'loading', message: 'Saving configuration and connecting...' })
      console.log('💾 Saving configuration with values:', localConfig)

      const response = await authFetch(API_ENDPOINTS.configurationUpdate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: localConfig.ip,
          path: localConfig.path,
          subsystemId: localConfig.subsystemId,
          apiPassword: localConfig.apiPassword || "",
          remoteUrl: localConfig.remoteUrl || ""
        })
      })

      if (response.ok) {
        const result = await response.json()
        console.log('✅ Configuration updated successfully:', result)

        // Show success with details
        const ioCount = result.ioCount || 0
        const message = ioCount > 0
          ? `Configuration saved! Loaded ${ioCount} IOs from cloud.`
          : 'Configuration saved! Check backend logs for connection status.'

        setSaveStatus({ type: 'success', message })

        // Notify parent to refresh data
        onConfigChange(localConfig)

        // Auto-close after showing success for 2 seconds
        setTimeout(() => {
          setSaveStatus({ type: null, message: '' })
          onOpenChange(false)
        }, 2000)
      } else {
        const error = await response.text()
        console.error('❌ Failed to update configuration:', response.status, error)
        setSaveStatus({ type: 'error', message: `Failed: ${error || response.statusText}` })
      }
    } catch (error: any) {
      console.error('❌ Error updating configuration:', error)
      setSaveStatus({ type: 'error', message: `Error: ${error.message}. Is backend running?` })
    } finally {
      setIsSaving(false)
    }
  }

  const handleDisconnect = async () => {
    try {
      setIsDisconnecting(true)
      const wasSaving = isSaving
      setSaveStatus({ type: 'loading', message: wasSaving ? 'Cancelling connection attempt...' : 'Disconnecting from PLC...' })
      console.log('🔌 Disconnecting from PLC...')

      const response = await authFetch(API_ENDPOINTS.plcDisconnect, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      // Reset saving state since we're cancelling
      if (wasSaving) {
        setIsSaving(false)
      }

      if (response.ok) {
        const result = await response.json()
        console.log('✅ PLC disconnected successfully:', result)
        setSaveStatus({ type: 'success', message: wasSaving ? 'Connection cancelled. You can now change configuration.' : 'PLC disconnected. You can now change configuration.' })

        // Clear status after 3 seconds
        setTimeout(() => {
          setSaveStatus({ type: null, message: '' })
        }, 3000)
      } else {
        const error = await response.text()
        console.error('❌ Failed to disconnect:', response.status, error)
        setSaveStatus({ type: 'error', message: `Failed to disconnect: ${error || response.statusText}` })
      }
    } catch (error: any) {
      console.error('❌ Error disconnecting from PLC:', error)
      setSaveStatus({ type: 'error', message: `Error: ${error.message}` })
    } finally {
      setIsDisconnecting(false)
    }
  }

  const handlePullIos = async () => {
    try {
      setIsPulling(true)
      setActivityLog([]) // Clear previous log
      addLog(`Starting pull from ${localConfig.remoteUrl}`)
      addLog(`Subsystem ID: ${localConfig.subsystemId}`)
      setSaveStatus({ type: 'loading', message: 'Connecting to cloud...' })

      // Create abort controller for timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000) // 30 second timeout

      try {
        addLog('Sending request to backend...')
        setSaveStatus({ type: 'loading', message: `Fetching IOs for subsystem ${localConfig.subsystemId}...` })

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
        addLog(`Response received: ${response.status} ${response.statusText}`)

        if (response.ok) {
          const result = await response.json()
          addLog(`Success: ${result.ioCount} IOs retrieved`)

          if (result.ioCount === 0) {
            addLog('ERROR: No IOs found - check subsystem ID')
            setSaveStatus({ type: 'error', message: `No IOs found for subsystem ${localConfig.subsystemId}. Check subsystem ID and API password.` })
          } else {
            setSaveStatus({ type: 'success', message: result.message || `Pulled ${result.ioCount} IOs from cloud` })
            // Notify parent to refresh data
            onConfigChange(localConfig)
            // Clear status after 3 seconds
            setTimeout(() => {
              setSaveStatus({ type: null, message: '' })
            }, 3000)
          }
        } else {
          let errorMsg = ''
          try {
            const errorData = await response.json()
            errorMsg = errorData.message || errorData.error || JSON.stringify(errorData)
          } catch {
            errorMsg = await response.text() || response.statusText
          }
          addLog(`ERROR: ${response.status} - ${errorMsg}`)

          // Provide helpful error messages
          if (response.status === 401 || response.status === 403) {
            setSaveStatus({ type: 'error', message: `Authentication failed. Check API password.` })
          } else if (response.status === 404) {
            setSaveStatus({ type: 'error', message: `Subsystem ${localConfig.subsystemId} not found. Check subsystem ID.` })
          } else {
            setSaveStatus({ type: 'error', message: `Failed (${response.status}): ${errorMsg}` })
          }
        }
      } catch (fetchError: any) {
        clearTimeout(timeoutId)
        if (fetchError.name === 'AbortError') {
          addLog('ERROR: Request timed out after 30s')
          setSaveStatus({ type: 'error', message: 'Request timed out. Check network and cloud URL.' })
        } else {
          throw fetchError
        }
      }
    } catch (error: any) {
      addLog(`ERROR: ${error.message}`)
      setSaveStatus({ type: 'error', message: `Error: ${error.message}. Is backend running?` })
    } finally {
      setIsPulling(false)
    }
  }

  const handleCancel = () => {
    // Reset to empty values - will be reloaded when dialog opens again
    setLocalConfig({
      ip: "",
      path: "",
      subsystemId: "",
      apiPassword: "",
      remoteUrl: ""
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col border-2 border-primary/20 bg-gradient-to-br from-background to-muted/30">
        <DialogHeader className="border-b border-primary/10 pb-4">
          <DialogTitle className="flex items-center gap-2 text-xl font-bold text-primary">
            <TestTube className="w-6 h-6 text-primary" />
            PLC Configuration
          </DialogTitle>
          <DialogDescription className="text-muted-foreground/80">
            Configure the PLC connection settings for real-time IO monitoring and testing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 overflow-y-auto flex-1">
          {/* Connection Settings */}
          <Card className="border-primary/20 bg-card/80 backdrop-blur-sm">
            <CardHeader className="bg-primary/5 border-b border-primary/10">
              <CardTitle className="text-lg text-primary font-semibold">Connection Settings</CardTitle>
              <CardDescription className="text-muted-foreground">
                Configure the network connection to your PLC
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ip">PLC IP Address</Label>
                  <Input
                    id="ip"
                    value={localConfig.ip}
                    onChange={(e) => setLocalConfig({ ...localConfig, ip: e.target.value })}
                    placeholder="192.168.1.100"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="path">Communication Path</Label>
                  <Input
                    id="path"
                    value={localConfig.path}
                    onChange={(e) => setLocalConfig({ ...localConfig, path: e.target.value })}
                    placeholder="1,0"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="subsystemId">Subsystem ID</Label>
                  <Input
                    id="subsystemId"
                    value={localConfig.subsystemId}
                    onChange={(e) => setLocalConfig({ ...localConfig, subsystemId: e.target.value })}
                    placeholder="1"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apiPassword">API Password</Label>
                  <Input
                    id="apiPassword"
                    type="text"
                    value={localConfig.apiPassword || ""}
                    onChange={(e) => setLocalConfig({ ...localConfig, apiPassword: e.target.value })}
                    placeholder="Project API password"
                  />
                </div>
              </div>

              {/* Remote URL Field */}
              <div className="space-y-2">
                <Label htmlFor="remoteUrl">Remote URL</Label>
                <Input
                  id="remoteUrl"
                  type="text"
                  value={localConfig.remoteUrl || ""}
                  onChange={(e) => setLocalConfig({ ...localConfig, remoteUrl: e.target.value })}
                  placeholder="https://your-cloud-service.com"
                />
              </div>

            </CardContent>
          </Card>

        </div>

        {/* Status Message */}
        {saveStatus.type && (
          <div className={`p-4 rounded-lg border-2 ${
            saveStatus.type === 'loading' ? 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-200' :
            saveStatus.type === 'success' ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-800 dark:text-green-200' :
            'bg-red-50 border-red-200 text-red-800 dark:bg-red-950 dark:border-red-800 dark:text-red-200'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {saveStatus.type === 'loading' && (
                  <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
                )}
                {saveStatus.type === 'success' && <span>✅</span>}
                {saveStatus.type === 'error' && <span>❌</span>}
                <span className="font-medium">{saveStatus.message}</span>
              </div>
              {saveStatus.type === 'loading' && elapsedTime > 0 && (
                <span className="text-sm opacity-75">{elapsedTime}s</span>
              )}
            </div>
          </div>
        )}

        {/* Activity Log */}
        {activityLog.length > 0 && (
          <div className="p-3 rounded-lg border bg-muted/50 dark:bg-muted/20">
            <div className="flex items-center gap-2 mb-2 text-xs font-medium text-muted-foreground">
              <Terminal className="w-3 h-3" />
              Activity Log
            </div>
            <div className="font-mono text-xs space-y-0.5 max-h-24 overflow-y-auto">
              {activityLog.map((log, i) => (
                <div key={i} className={log.includes('ERROR') ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}>
                  {log}
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="mt-6 border-t border-primary/10 pt-4 flex flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={isDisconnecting || isPulling}
              className="min-w-[140px]"
            >
              <Unplug className="w-4 h-4 mr-2" />
              {isDisconnecting ? "Disconnecting..." : isSaving ? "Cancel" : "Disconnect"}
            </Button>
            <Button
              variant="outline"
              onClick={handlePullIos}
              className="border-blue-500/50 text-blue-600 hover:bg-blue-50 min-w-[100px]"
              disabled={isPulling || isSaving || isDisconnecting}
            >
              <CloudDownload className="w-4 h-4 mr-2" />
              {isPulling ? "Pulling..." : "Pull IOs"}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleCancel} className="border-primary/30 hover:bg-muted/50" disabled={isSaving || isDisconnecting || isPulling}>
              Cancel
            </Button>
            <Button onClick={handleSave} className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold min-w-[160px]" disabled={isSaving || isDisconnecting || isPulling}>
              {isSaving ? "Saving..." : "Save & Reconnect"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
