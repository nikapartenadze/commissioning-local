"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  Wifi, 
  WifiOff, 
  Cloud, 
  CloudOff, 
  AlertCircle,
  CheckCircle,
  Clock,
  RefreshCw
} from "lucide-react"
import { cn } from "@/lib/utils"

interface ConnectionStatus {
  plc: {
    connected: boolean
    lastConnected?: string
    error?: string
  }
  cloud: {
    connected: boolean
    lastSync?: string
    error?: string
  }
  testing: {
    active: boolean
    startedAt?: string
  }
}

interface ConnectionStatusIndicatorProps {
  status?: ConnectionStatus
  onReconnect?: () => void
  onRefresh?: () => void
  className?: string
  showDetails?: boolean
}

export function ConnectionStatusIndicator({
  status,
  onReconnect,
  onRefresh,
  className = "",
  showDetails = false
}: ConnectionStatusIndicatorProps) {
  // Default fallback status
  const defaultStatus: ConnectionStatus = {
    plc: { connected: false },
    cloud: { connected: false },
    testing: { active: false }
  }
  
  const currentStatus = status || defaultStatus

  const getStatusColor = (connected: boolean, hasError?: boolean) => {
    if (hasError) return "text-red-500"
    return connected ? "text-green-500" : "text-red-500"
  }

  const getStatusIcon = (connected: boolean, hasError?: boolean) => {
    if (hasError) return <AlertCircle className="h-4 w-4" />
    return connected ? <CheckCircle className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />
  }

  return (
    <div className={cn("flex items-center space-x-4", className)}>
      {/* Cloud Connection Status */}
      <div className="flex items-center space-x-2">
        <div className="flex items-center space-x-1">
          {currentStatus.cloud.connected ? (
            <Cloud className="h-4 w-4 text-green-500" />
          ) : (
            <CloudOff className="h-4 w-4 text-red-500" />
          )}
          <span className="text-sm font-medium">Cloud</span>
        </div>
        <Badge 
          variant={currentStatus.cloud.connected ? "default" : "secondary"}
          className="text-xs"
        >
          {currentStatus.cloud.connected ? "Online" : "Offline"}
        </Badge>
        {currentStatus.cloud.error && (
          <span className="text-xs text-red-500" title={currentStatus.cloud.error}>
            Error
          </span>
        )}
      </div>

      {/* Testing Status */}
      {currentStatus.testing.active && (
        <div className="flex items-center space-x-2">
          <div className="flex items-center space-x-1">
            <Clock className="h-4 w-4 text-blue-500" />
            <span className="text-sm font-medium">Testing</span>
          </div>
          <Badge variant="default" className="text-xs bg-blue-500">
            Active
          </Badge>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center space-x-1">
        {onRefresh && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            title="Refresh Status"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
        {onReconnect && !currentStatus.plc.connected && (
          <Button
            variant="outline"
            size="sm"
            onClick={onReconnect}
            title="Reconnect to PLC"
          >
            <Wifi className="h-4 w-4 mr-1" />
            Reconnect
          </Button>
        )}
      </div>

      {/* Detailed Status (if enabled) */}
      {showDetails && (
        <div className="text-xs text-muted-foreground space-y-1">
          {currentStatus.plc.lastConnected && (
            <div>PLC: Last connected {currentStatus.plc.lastConnected}</div>
          )}
          {currentStatus.cloud.lastSync && (
            <div>Cloud: Last sync {currentStatus.cloud.lastSync}</div>
          )}
          {currentStatus.testing.startedAt && (
            <div>Testing: Started {currentStatus.testing.startedAt}</div>
          )}
        </div>
      )}
    </div>
  )
}

// Compact version for headers/toolbars
export function CompactConnectionStatus({
  status,
  className = ""
}: {
  status?: ConnectionStatus
  className?: string
}) {
  // Default fallback status
  const defaultStatus: ConnectionStatus = {
    plc: { connected: false },
    cloud: { connected: false },
    testing: { active: false }
  }
  
  const currentStatus = status || defaultStatus

  return (
    <div className={cn("flex items-center space-x-2", className)}>
      {/* PLC Status */}
      <div className="flex items-center space-x-1">
        {currentStatus.plc.connected ? (
          <Wifi className="h-4 w-4 text-green-500" />
        ) : (
          <WifiOff className="h-4 w-4 text-red-500" />
        )}
        <span className="text-xs">PLC</span>
      </div>

      {/* Cloud Status */}
      <div className="flex items-center space-x-1">
        {currentStatus.cloud.connected ? (
          <Cloud className="h-4 w-4 text-green-500" />
        ) : (
          <CloudOff className="h-4 w-4 text-red-500" />
        )}
        <span className="text-xs">Cloud</span>
      </div>

      {/* Testing Status */}
      {currentStatus.testing.active && (
        <div className="flex items-center space-x-1">
          <Clock className="h-4 w-4 text-blue-500" />
          <span className="text-xs">Testing</span>
        </div>
      )}
    </div>
  )
}
