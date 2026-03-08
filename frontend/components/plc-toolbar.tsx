"use client"

import { Button } from "@/components/ui/button"
import {
  Play,
  Square,
  BarChart3,
  Download,
  History,
  Cloud,
  CloudOff,
  Cpu,
  Settings,
  Zap,
  ZapOff,
  AlertTriangle,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface TagStatus {
  totalTags: number
  successfulTags: number
  failedTags: number
  hasErrors: boolean
}

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
  activeFilter?: 'failed' | 'not-tested' | 'passed' | 'inputs' | 'outputs' | null
  onFilterChange?: (filter: 'failed' | 'not-tested' | 'passed' | 'inputs' | 'outputs' | null) => void
  tagStatus?: TagStatus | null
  onShowTagStatus?: () => void
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
  onFilterChange,
  tagStatus = null,
  onShowTagStatus
}: PlcToolbarProps) {
  const progressPercent = totalIos > 0 ? ((passedIos + failedIos) / totalIos) * 100 : 0
  const passedPercent = totalIos > 0 ? (passedIos / totalIos) * 100 : 0

  return (
    <div className="bg-card border-y border-border">
      {/* Main Toolbar Row */}
      <div className="flex items-center gap-2 p-2 flex-wrap">
        {/* START/STOP Button - Large and prominent */}
        <Button
          size="lg"
          className={cn(
            "h-14 px-6 text-lg font-bold uppercase tracking-wider transition-all min-w-[160px]",
            isTesting
              ? "bg-red-600 hover:bg-red-700 text-white animate-pulse"
              : "bg-green-600 hover:bg-green-700 text-white"
          )}
          onClick={onToggleTesting}
          title={isTesting ? "Click to stop testing mode" : "Click to start testing mode"}
        >
          {isTesting ? (
            <>
              <Square className="w-6 h-6 mr-2" />
              STOP
            </>
          ) : (
            <>
              <Play className="w-6 h-6 mr-2" />
              START
            </>
          )}
        </Button>

        {/* Divider */}
        <div className="w-px h-10 bg-border" />

        {/* Quick Filter Buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => onFilterChange?.(activeFilter === 'passed' ? null : 'passed')}
            className={cn(
              "h-14 px-4 flex flex-col items-center justify-center rounded-md transition-all font-mono",
              activeFilter === 'passed'
                ? "bg-green-600 text-white"
                : "bg-green-500/10 hover:bg-green-500/20 text-green-600 dark:text-green-400"
            )}
          >
            <span className="text-2xl font-bold leading-none">{passedIos}</span>
            <span className="text-[10px] uppercase tracking-wider font-sans opacity-80">Passed</span>
          </button>

          <button
            onClick={() => onFilterChange?.(activeFilter === 'failed' ? null : 'failed')}
            className={cn(
              "h-14 px-4 flex flex-col items-center justify-center rounded-md transition-all font-mono",
              activeFilter === 'failed'
                ? "bg-red-600 text-white"
                : "bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400"
            )}
          >
            <span className="text-2xl font-bold leading-none">{failedIos}</span>
            <span className="text-[10px] uppercase tracking-wider font-sans opacity-80">Failed</span>
          </button>

          <button
            onClick={() => onFilterChange?.(activeFilter === 'not-tested' ? null : 'not-tested')}
            className={cn(
              "h-14 px-4 flex flex-col items-center justify-center rounded-md transition-all font-mono",
              activeFilter === 'not-tested'
                ? "bg-slate-600 text-white"
                : "bg-slate-500/10 hover:bg-slate-500/20 text-slate-600 dark:text-slate-400"
            )}
          >
            <span className="text-2xl font-bold leading-none">{notTestedIos}</span>
            <span className="text-[10px] uppercase tracking-wider font-sans opacity-80">Remaining</span>
          </button>

          <div className="w-px h-8 bg-border mx-1" />

          <button
            onClick={() => onFilterChange?.(activeFilter === 'inputs' ? null : 'inputs')}
            className={cn(
              "h-14 px-4 flex items-center justify-center rounded-md transition-all text-sm font-medium",
              activeFilter === 'inputs'
                ? "bg-blue-600 text-white"
                : "bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400"
            )}
          >
            Inputs
          </button>

          <button
            onClick={() => onFilterChange?.(activeFilter === 'outputs' ? null : 'outputs')}
            className={cn(
              "h-14 px-4 flex items-center justify-center rounded-md transition-all text-sm font-medium",
              activeFilter === 'outputs'
                ? "bg-orange-600 text-white"
                : "bg-orange-500/10 hover:bg-orange-500/20 text-orange-600 dark:text-orange-400"
            )}
          >
            Outputs
          </button>
        </div>

        {/* Progress Bar - Flex grow to fill space */}
        <div className="flex-1 mx-4 min-w-[200px]">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-8 bg-muted rounded-full overflow-hidden relative">
              {/* Passed portion (green) */}
              <div
                className="absolute inset-y-0 left-0 bg-green-500 transition-all duration-500"
                style={{ width: `${passedPercent}%` }}
              />
              {/* Failed portion (red) - starts after passed */}
              <div
                className="absolute inset-y-0 bg-red-500 transition-all duration-500"
                style={{
                  left: `${passedPercent}%`,
                  width: `${totalIos > 0 ? (failedIos / totalIos) * 100 : 0}%`
                }}
              />
              {/* Progress text overlay */}
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-sm font-bold text-foreground drop-shadow-sm">
                  {Math.round(progressPercent)}% Complete ({passedIos + failedIos} / {totalIos})
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="w-px h-10 bg-border" />

        {/* Action Buttons */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="lg"
            className="h-12 w-12 p-0"
            onClick={onShowGraph}
            title="Show Graph"
          >
            <BarChart3 className="w-6 h-6" />
          </Button>

          <Button
            variant="ghost"
            size="lg"
            className="h-12 w-12 p-0"
            onClick={onDownloadCsv}
            title="Export CSV"
          >
            <Download className="w-6 h-6" />
          </Button>

          <Button
            variant="ghost"
            size="lg"
            className="h-12 w-12 p-0"
            onClick={onShowHistory}
            title="Test History"
          >
            <History className="w-6 h-6" />
          </Button>
        </div>

        {/* Divider */}
        <div className="w-px h-10 bg-border" />

        {/* Status & Config */}
        <div className="flex items-center gap-1">
          {/* Simulator Toggle - Admin only */}
          {currentUser?.isAdmin && onToggleSimulator && (
            <Button
              variant={isSimulatorEnabled ? "default" : "ghost"}
              size="lg"
              className={cn(
                "h-12 px-3",
                isSimulatorEnabled && "bg-purple-600 hover:bg-purple-700 text-white"
              )}
              onClick={onToggleSimulator}
              title={isSimulatorEnabled ? "Disable Simulator" : "Enable Simulator"}
            >
              {isSimulatorEnabled ? (
                <ZapOff className="w-5 h-5" />
              ) : (
                <Zap className="w-5 h-5" />
              )}
              <span className="ml-2 text-xs uppercase hidden lg:inline">
                {isSimulatorEnabled ? "SIM ON" : "SIM"}
              </span>
            </Button>
          )}

          {/* PLC Status - Click to configure */}
          <Button
            variant={isPlcConnected ? "ghost" : "outline"}
            size="lg"
            className={cn(
              "h-12 px-3 gap-2",
              isPlcConnected
                ? "text-green-600"
                : "text-red-600 border-red-500/50 bg-red-500/10 hover:bg-red-500/20 animate-pulse"
            )}
            onClick={onShowConfig}
            title={isPlcConnected ? "PLC Connected - Click to configure" : "PLC Disconnected - Click to configure"}
          >
            <Cpu className={cn("w-5 h-5", isPlcConnected && "status-pulse")} />
            <span className="text-xs uppercase">
              {isPlcConnected ? "PLC OK" : "SETUP PLC"}
            </span>
          </Button>

          {/* Tag Status Indicator */}
          {tagStatus && tagStatus.totalTags > 0 && (
            <Button
              variant={tagStatus.hasErrors ? "outline" : "ghost"}
              size="lg"
              className={cn(
                "h-12 px-3 gap-1.5",
                tagStatus.hasErrors
                  ? "text-amber-600 border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20"
                  : "text-green-600"
              )}
              onClick={onShowTagStatus}
              title={tagStatus.hasErrors
                ? `${tagStatus.failedTags} tags have errors - click for details`
                : `All ${tagStatus.totalTags} tags working`}
            >
              {tagStatus.hasErrors && <AlertTriangle className="w-4 h-4" />}
              <span className="text-xs font-mono">
                {tagStatus.successfulTags}/{tagStatus.totalTags}
              </span>
              <span className="text-[10px] uppercase hidden lg:inline">TAGS</span>
            </Button>
          )}

          {/* Cloud Status */}
          <Button
            variant="ghost"
            size="lg"
            className={cn(
              "h-12 px-3 gap-2",
              isCloudConnected ? "text-green-600" : "text-amber-600"
            )}
            onClick={onCloudSync}
            title={isCloudConnected ? "Cloud Connected" : "Offline Mode"}
          >
            {isCloudConnected ? (
              <Cloud className="w-5 h-5" />
            ) : (
              <CloudOff className="w-5 h-5" />
            )}
            <span className="text-xs uppercase hidden lg:inline">
              {isCloudConnected ? "CLOUD" : "OFFLINE"}
            </span>
          </Button>

        </div>
      </div>
    </div>
  )
}
