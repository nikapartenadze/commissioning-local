"use client"

import { useState, useEffect } from "react"
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
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TestTube } from "lucide-react"

interface PlcConfig {
  ip: string
  path: string
  subsystemId: string
  disableWatchdog: boolean
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
    disableWatchdog: false,
    apiPassword: "",
    remoteUrl: ""
  })
  const [isSaving, setIsSaving] = useState(false)
  const [isLoadingConfig, setIsLoadingConfig] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error' | 'loading' | null; message: string }>({ type: null, message: '' })

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
      const response = await fetch('http://localhost:5000/api/status')
      if (response.ok) {
        const status = await response.json()
        console.log('📡 Raw status response from C# backend:', status)
        
        const actualConfig: PlcConfig = {
          ip: status.plcIp || "192.168.20.14",
          path: status.plcPath || "1,1", 
          subsystemId: status.subsystemId || "16",
          disableWatchdog: status.disableTesting || false,
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

      const response = await fetch('http://localhost:5000/api/configuration/update-config-json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: localConfig.ip,
          path: localConfig.path,
          subsystemId: localConfig.subsystemId,
          disableWatchdog: localConfig.disableWatchdog,
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


  const handleCancel = () => {
    // Reset to empty values - will be reloaded when dialog opens again
    setLocalConfig({
      ip: "",
      path: "",
      subsystemId: "",
      disableWatchdog: false,
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

              {/* Watchdog Setting */}
              <div className="flex items-center justify-between p-4 border-2 border-primary/20 rounded-lg bg-muted/30">
                <div className="space-y-0.5">
                  <Label htmlFor="disableWatchdog" className="text-base font-medium">Disable Watchdog</Label>
                  <p className="text-sm text-muted-foreground">
                    {localConfig.disableWatchdog ? "Watchdog is DISABLED - Testing without PLC connection" : "Watchdog is ENABLED - Safety monitoring active"}
                  </p>
                </div>
                <Switch
                  id="disableWatchdog"
                  checked={localConfig.disableWatchdog}
                  onCheckedChange={(checked) => 
                    setLocalConfig({ ...localConfig, disableWatchdog: checked })
                  }
                />
              </div>
            </CardContent>
          </Card>

        </div>

        {/* Status Message */}
        {saveStatus.type && (
          <div className={`p-4 rounded-lg border-2 ${
            saveStatus.type === 'loading' ? 'bg-blue-50 border-blue-200 text-blue-800' :
            saveStatus.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' :
            'bg-red-50 border-red-200 text-red-800'
          }`}>
            <div className="flex items-center gap-2">
              {saveStatus.type === 'loading' && (
                <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
              )}
              {saveStatus.type === 'success' && <span>✅</span>}
              {saveStatus.type === 'error' && <span>❌</span>}
              <span className="font-medium">{saveStatus.message}</span>
            </div>
          </div>
        )}

        <DialogFooter className="mt-6 border-t border-primary/10 pt-4">
          <Button variant="outline" onClick={handleCancel} className="border-primary/30 hover:bg-muted/50" disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold" disabled={isSaving}>
            {isSaving ? "Saving & Reconnecting..." : "Save & Reconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
