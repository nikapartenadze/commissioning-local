'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'
import { authFetch } from '@/lib/api-config'

interface SubsystemConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  subsystemId: number
  subsystemName: string
  existingConfig?: {
    id: number
    ip: string
    path: string
    remoteUrl?: string
    apiPassword?: string
  } | null
  onSave: () => void
}

export function SubsystemConfigDialog({
  open,
  onOpenChange,
  projectName,
  subsystemId,
  subsystemName,
  existingConfig,
  onSave
}: SubsystemConfigDialogProps) {
  const [config, setConfig] = useState({
    ip: '',
    path: '1,0',
    remoteUrl: '',
    apiPassword: ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load existing config if available
  useEffect(() => {
    if (existingConfig) {
      setConfig({
        ip: existingConfig.ip,
        path: existingConfig.path,
        remoteUrl: existingConfig.remoteUrl || '',
        apiPassword: existingConfig.apiPassword || ''
      })
    }
  }, [existingConfig])

  const handleSave = async () => {
    if (!config.ip) {
      setError('IP Address is required')
      return
    }

    if (!config.path) {
      setError('PLC Path is required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const url = existingConfig
        ? `/api/configurations/${existingConfig.id}`
        : '/api/configurations'
      
      const method = existingConfig ? 'PUT' : 'POST'
      
      const payload = existingConfig
        ? {
            id: existingConfig.id,
            projectName,
            subsystemId,
            subsystemName,
            ...config,
            orderMode: false,
            showStateColumn: true,
            showResultColumn: true,
            showTimestampColumn: true,
            showHistoryColumn: true
          }
        : {
            projectName,
            subsystemId,
            subsystemName,
            ...config,
            orderMode: false,
            showStateColumn: true,
            showResultColumn: true,
            showTimestampColumn: true,
            showHistoryColumn: true
          }

      const response = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (response.ok) {
        onSave()
        onOpenChange(false)
      } else {
        const errorData = await response.json()
        setError(errorData.error || 'Failed to save configuration')
      }
    } catch (error) {
      console.error('Error saving configuration:', error)
      setError('Error saving configuration. Make sure the C# backend is running.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>
            {existingConfig ? 'Edit' : 'Configure'} Connection - {projectName}
          </DialogTitle>
          <DialogDescription>
            Subsystem {subsystemId} - {subsystemName}
          </DialogDescription>
        </DialogHeader>
        
        <div className="grid gap-4 py-4">
          {error && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="ip" className="text-sm font-medium">
              PLC IP Address <span className="text-red-500">*</span>
            </Label>
            <Input
              id="ip"
              placeholder="192.168.1.100"
              value={config.ip}
              onChange={(e) => setConfig({ ...config, ip: e.target.value })}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              The IP address of the PLC to connect to
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="path" className="text-sm font-medium">
              PLC Path <span className="text-red-500">*</span>
            </Label>
            <Input
              id="path"
              placeholder="1,0"
              value={config.path}
              onChange={(e) => setConfig({ ...config, path: e.target.value })}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Communication path to the PLC (e.g., 1,0 or 1,2)
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="remoteUrl" className="text-sm font-medium">
              Cloud Remote URL <span className="text-muted-foreground">(Optional)</span>
            </Label>
            <Input
              id="remoteUrl"
              placeholder="https://cloud.example.com"
              value={config.remoteUrl}
              onChange={(e) => setConfig({ ...config, remoteUrl: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Cloud service URL for syncing test data
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="apiPassword" className="text-sm font-medium">
              API Password <span className="text-muted-foreground">(Optional)</span>
            </Label>
            <Input
              id="apiPassword"
              type="password"
              placeholder="Enter API password"
              value={config.apiPassword}
              onChange={(e) => setConfig({ ...config, apiPassword: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Password for cloud API authentication
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button 
            variant="outline" 
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={saving || !config.ip || !config.path}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saving ? 'Saving...' : existingConfig ? 'Update' : 'Save'} Configuration
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

