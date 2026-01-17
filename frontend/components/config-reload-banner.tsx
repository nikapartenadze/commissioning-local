"use client"

import { useEffect, useState, useCallback } from "react"
import { AlertCircle, RefreshCw, CheckCircle, Settings } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSignalR, ConfigurationEvent } from "@/lib/signalr-client"
import { getRuntimeConfig, RuntimeConfig, refreshRuntimeConfig } from "@/lib/api-config"

interface ConfigReloadBannerProps {
  className?: string
  onReloadComplete?: () => void
}

/**
 * Banner component that displays configuration reload status.
 * Shows when config.json is externally modified and the backend is reinitializing.
 *
 * States:
 * - idle: No active reload
 * - reloading: Configuration is being reloaded (show spinner)
 * - reloaded: Reload complete, prompting user to refresh data
 */
export function ConfigReloadBanner({ className, onReloadComplete }: ConfigReloadBannerProps) {
  const { isConfigReloading, onConfigurationChange, offConfigurationChange } = useSignalR()
  const [status, setStatus] = useState<'idle' | 'reloading' | 'reloaded'>('idle')
  const [showBanner, setShowBanner] = useState(false)
  const [config, setConfig] = useState<RuntimeConfig | null>(null)

  // Handle configuration change events
  const handleConfigChange = useCallback(async (event: ConfigurationEvent) => {
    if (event.type === 'reloading') {
      setStatus('reloading')
      setShowBanner(true)
    } else if (event.type === 'reloaded') {
      setStatus('reloaded')
      // Fetch the new configuration
      try {
        const newConfig = await refreshRuntimeConfig()
        setConfig(newConfig)
      } catch (error) {
        console.error('Failed to refresh config:', error)
      }
      // Auto-hide after 5 seconds
      setTimeout(() => {
        setShowBanner(false)
        setStatus('idle')
        onReloadComplete?.()
      }, 5000)
    }
  }, [onReloadComplete])

  // Subscribe to configuration changes
  useEffect(() => {
    onConfigurationChange(handleConfigChange)
    return () => {
      offConfigurationChange(handleConfigChange)
    }
  }, [handleConfigChange, onConfigurationChange, offConfigurationChange])

  // Sync with SignalR isConfigReloading state
  useEffect(() => {
    if (isConfigReloading && status === 'idle') {
      setStatus('reloading')
      setShowBanner(true)
    }
  }, [isConfigReloading, status])

  // Don't render anything if no active status
  if (!showBanner) {
    return null
  }

  return (
    <div
      className={cn(
        "fixed top-0 left-0 right-0 z-50 px-4 py-3 shadow-lg transition-all duration-300",
        status === 'reloading' && "bg-yellow-500 text-yellow-950",
        status === 'reloaded' && "bg-green-500 text-green-950",
        className
      )}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center space-x-3">
          {status === 'reloading' && (
            <>
              <RefreshCw className="h-5 w-5 animate-spin" />
              <div>
                <span className="font-semibold">Configuration Reloading...</span>
                <span className="ml-2 text-sm opacity-90">
                  External change detected in config.json. Reinitializing connections.
                </span>
              </div>
            </>
          )}
          {status === 'reloaded' && (
            <>
              <CheckCircle className="h-5 w-5" />
              <div>
                <span className="font-semibold">Configuration Updated</span>
                <span className="ml-2 text-sm opacity-90">
                  {config && `PLC: ${config.plcIp} | Subsystem: ${config.subsystemId}`}
                </span>
              </div>
            </>
          )}
        </div>

        <button
          onClick={() => {
            setShowBanner(false)
            setStatus('idle')
          }}
          className="text-sm underline hover:no-underline opacity-80 hover:opacity-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

/**
 * Compact indicator for headers/toolbars showing config status
 */
export function ConfigStatusIndicator({ className }: { className?: string }) {
  const { isConfigReloading } = useSignalR()
  const [config, setConfig] = useState<RuntimeConfig | null>(null)
  const [loading, setLoading] = useState(true)

  // Fetch initial config
  useEffect(() => {
    getRuntimeConfig()
      .then(setConfig)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  // Refresh when reload completes
  useEffect(() => {
    if (!isConfigReloading && config) {
      refreshRuntimeConfig()
        .then(setConfig)
        .catch(console.error)
    }
  }, [isConfigReloading])

  if (loading) {
    return (
      <div className={cn("flex items-center space-x-1 text-muted-foreground", className)}>
        <RefreshCw className="h-3 w-3 animate-spin" />
        <span className="text-xs">Loading...</span>
      </div>
    )
  }

  if (isConfigReloading) {
    return (
      <div className={cn("flex items-center space-x-1 text-yellow-600", className)}>
        <RefreshCw className="h-3 w-3 animate-spin" />
        <span className="text-xs font-medium">Reloading Config...</span>
      </div>
    )
  }

  return (
    <div className={cn("flex items-center space-x-1 text-muted-foreground", className)}>
      <Settings className="h-3 w-3" />
      <span className="text-xs">
        {config?.plcIp || 'Not configured'} | SS{config?.subsystemId || '?'}
      </span>
      {config?.cloudConnected && (
        <span className="text-xs text-green-600">Cloud</span>
      )}
    </div>
  )
}
