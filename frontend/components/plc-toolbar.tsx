"use client"

import { useState, useEffect } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Play,
  Square,
  BarChart3,
  Download,
  History,
  Wifi,
  WifiOff,
  Cloud,
  CloudOff,
  Cpu,
  Monitor,
  Zap,
  ZapOff,
  Filter
} from "lucide-react"
import { cn } from "@/lib/utils"

interface PlcToolbarProps {
  isTesting: boolean
  isPlcConnected: boolean
  isCloudConnected: boolean
  totalIos: number
  passedIos: number
  failedIos: number
  notTestedIos: number
  onToggleTesting: () => void
  onShowGraph: () => void
  onDownloadCsv: () => void
  onShowHistory: () => void
  onShowConfig: () => void
  onCloudSync: () => void
  currentUser?: { isAdmin: boolean; fullName: string } | null
  onToggleSimulator?: () => void
  isSimulatorEnabled?: boolean
  activeFilter?: 'failed' | 'not-tested' | 'passed' | null
  onFilterChange?: (filter: 'failed' | 'not-tested' | 'passed' | null) => void
}

export function PlcToolbar({
  isTesting,
  isPlcConnected,
  isCloudConnected,
  totalIos,
  passedIos,
  failedIos,
  notTestedIos,
  onToggleTesting,
  onShowGraph,
  onDownloadCsv,
  onShowHistory,
  onShowConfig,
  onCloudSync,
  currentUser,
  onToggleSimulator,
  isSimulatorEnabled = false,
  activeFilter = null,
  onFilterChange
}: PlcToolbarProps) {
  const [watchdogColor, setWatchdogColor] = useState("")

  useEffect(() => {
    if (isTesting) {
      setWatchdogColor("text-green-600")
    } else {
      setWatchdogColor("text-gray-500")
    }
  }, [isTesting])

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between p-4 bg-muted/50">
        {/* Left Side - Main Controls */}
        <div className="flex items-center space-x-2">
          {/* Start/Stop Testing */}
          <Button
            variant="default"
            size="lg"
            className={cn(
              "transition-all duration-300 font-bold text-lg px-6 py-3",
              isTesting 
                ? "bg-green-600 hover:bg-green-700 text-white shadow-lg" 
                : "bg-amber-600 hover:bg-amber-700 text-white"
            )}
            onClick={() => {
              console.log('🔴 Start Testing button clicked!')
              onToggleTesting()
            }}
            title={isTesting ? "Stop Testing" : "Start Testing"}
          >
            {isTesting ? (
              <>
                <Square className="w-5 h-5 mr-2" />
                STOP TESTING
              </>
            ) : (
              <>
                <Play className="w-5 h-5 mr-2" />
                START TESTING
              </>
            )}
          </Button>

          {/* Show Graph */}
          <Button
            variant="ghost"
            size="lg"
            onClick={onShowGraph}
            title="Show Graph"
          >
            <BarChart3 className="w-6 h-6" />
          </Button>

          {/* Export CSV */}
          <Button
            variant="ghost"
            size="lg"
            onClick={onDownloadCsv}
            title="Export Table as CSV"
          >
            <Download className="w-6 h-6" />
          </Button>

          {/* Show History */}
          <Button
            variant="ghost"
            size="lg"
            onClick={onShowHistory}
            title="Show Test History"
          >
            <History className="w-6 h-6" />
          </Button>

        </div>

        {/* Center - Quick Filters */}
        <div className="flex items-center gap-1">
          <Filter className="w-4 h-4 text-muted-foreground mr-1" />
          <Button
            variant={activeFilter === 'failed' ? 'default' : 'outline'}
            size="sm"
            className={cn(
              "text-xs",
              activeFilter === 'failed'
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "text-red-600 border-red-200 hover:bg-red-50"
            )}
            onClick={() => onFilterChange?.(activeFilter === 'failed' ? null : 'failed')}
          >
            Failed ({failedIos})
          </Button>
          <Button
            variant={activeFilter === 'not-tested' ? 'default' : 'outline'}
            size="sm"
            className={cn(
              "text-xs",
              activeFilter === 'not-tested'
                ? "bg-gray-600 hover:bg-gray-700 text-white"
                : "text-muted-foreground border-muted hover:bg-muted/50"
            )}
            onClick={() => onFilterChange?.(activeFilter === 'not-tested' ? null : 'not-tested')}
          >
            Not Tested ({notTestedIos})
          </Button>
          <Button
            variant={activeFilter === 'passed' ? 'default' : 'outline'}
            size="sm"
            className={cn(
              "text-xs",
              activeFilter === 'passed'
                ? "bg-green-600 hover:bg-green-700 text-white"
                : "text-green-600 border-green-200 hover:bg-green-50"
            )}
            onClick={() => onFilterChange?.(activeFilter === 'passed' ? null : 'passed')}
          >
            Passed ({passedIos})
          </Button>
        </div>

        {/* Right Side - Connection Status */}
        <div className="flex items-center space-x-2">
          {/* Simulator Control - ADMIN ONLY */}
          {currentUser?.isAdmin && onToggleSimulator && (
            <Button
              variant={isSimulatorEnabled ? "default" : "outline"}
              size="sm"
              onClick={onToggleSimulator}
              className={cn(
                "transition-all",
                isSimulatorEnabled && "bg-purple-600 hover:bg-purple-700 text-white"
              )}
              title={isSimulatorEnabled ? "Disable PLC Simulator" : "Enable PLC Simulator (Testing Mode)"}
            >
              {isSimulatorEnabled ? (
                <>
                  <ZapOff className="w-4 h-4 mr-1" />
                  <span className="hidden sm:inline">Simulator ON</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 mr-1" />
                  <span className="hidden sm:inline">Simulator</span>
                </>
              )}
            </Button>
          )}

          {/* PLC Connection Status */}
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "min-w-[40px] transition-colors",
              isPlcConnected ? "text-green-600" : "text-red-600"
            )}
            onClick={onShowConfig}
            title={isPlcConnected ? "PLC Connected - Click to edit config" : "PLC Disconnected - Click to edit config"}
          >
            {isPlcConnected ? (
              <Cpu className="w-5 h-5" />
            ) : (
              <Monitor className="w-5 h-5" />
            )}
          </Button>

          {/* Cloud Connection Status */}
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "min-w-[40px] transition-colors",
              isCloudConnected ? "text-green-600" : "text-red-600"
            )}
            onClick={onCloudSync}
            disabled={!isCloudConnected}
            title={isCloudConnected ? "Connected to cloud - Click to sync" : "Offline - syncing locally"}
          >
            {isCloudConnected ? (
              <Cloud className="w-5 h-5" />
            ) : (
              <CloudOff className="w-5 h-5" />
            )}
          </Button>

        </div>
      </div>

      {/* Status Bar with IO Statistics */}
      <div className="px-4 py-2 bg-muted/30 border-t">
        <div className="flex items-center justify-center gap-2">
          <div className="flex items-center gap-1 px-2 py-1 bg-background/50 rounded-md text-xs">
            <span className="font-semibold text-foreground">{totalIos}</span>
            <span className="text-muted-foreground">Total</span>
          </div>
          <div className="flex items-center gap-1 px-2 py-1 bg-green-500/10 rounded-md text-xs">
            <span className="font-semibold text-green-600">{passedIos}</span>
            <span className="text-green-600/70">Passed</span>
          </div>
          <div className="flex items-center gap-1 px-2 py-1 bg-red-500/10 rounded-md text-xs">
            <span className="font-semibold text-red-600">{failedIos}</span>
            <span className="text-red-600/70">Failed</span>
          </div>
          <div className="flex items-center gap-1 px-2 py-1 bg-background/50 rounded-md text-xs">
            <span className="font-semibold text-foreground">{notTestedIos}</span>
            <span className="text-muted-foreground">Not Tested</span>
          </div>
        </div>
      </div>
    </Card>
  )
}
