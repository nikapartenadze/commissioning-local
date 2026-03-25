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
  FileEdit,
  FileText,
  HelpCircle,
} from "lucide-react"
import Link from "next/link"
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
  isPlcReconnecting?: boolean
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
  onShowChangeRequests?: () => void
  onStartTour?: () => void
  subsystemId?: string
}

export function PlcToolbar({
  isTesting,
  isPlcConnected,
  isPlcReconnecting = false,
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
  onShowTagStatus,
  onShowChangeRequests,
  onStartTour,
  subsystemId
}: PlcToolbarProps) {
  const progressPercent = totalIos > 0 ? ((passedIos + failedIos) / totalIos) * 100 : 0
  const passedPercent = totalIos > 0 ? (passedIos / totalIos) * 100 : 0

  return (
    <div className="bg-card border-y border-border">
      {/* Main Toolbar Row */}
      <div className="flex items-center gap-1.5 sm:gap-2 p-1.5 sm:p-2 flex-wrap">
        {/* START/STOP Button */}
        <Button
          data-tour="start-button"
          size="lg"
          className={cn(
            "h-11 sm:h-14 px-3 sm:px-6 text-sm sm:text-lg font-bold uppercase tracking-wider transition-all",
            isTesting
              ? "bg-red-600 hover:bg-red-700 text-white animate-pulse"
              : "bg-green-600 hover:bg-green-700 text-white"
          )}
          onClick={onToggleTesting}
          title={isTesting ? "Click to stop testing mode" : "Click to start testing mode"}
        >
          {isTesting ? (
            <>
              <Square className="w-5 h-5 sm:w-6 sm:h-6 mr-1 sm:mr-2" />
              STOP
            </>
          ) : (
            <>
              <Play className="w-5 h-5 sm:w-6 sm:h-6 mr-1 sm:mr-2" />
              START
            </>
          )}
        </Button>

        {/* Divider - hidden on small screens */}
        <div className="w-px h-10 bg-border hidden sm:block" />

        {/* Quick Filter Buttons */}
        <div className="flex items-center gap-0.5 sm:gap-1">
          <button
            onClick={() => onFilterChange?.(activeFilter === 'passed' ? null : 'passed')}
            className={cn(
              "h-11 sm:h-14 px-2 sm:px-4 flex flex-col items-center justify-center rounded-md transition-all font-mono",
              activeFilter === 'passed'
                ? "bg-green-600 text-white"
                : "bg-green-500/10 hover:bg-green-500/20 text-green-600 dark:text-green-400"
            )}
          >
            <span className="text-lg sm:text-2xl font-bold leading-none">{passedIos}</span>
            <span className="text-[9px] sm:text-[10px] uppercase tracking-wider font-sans opacity-80">Pass</span>
          </button>

          <button
            onClick={() => onFilterChange?.(activeFilter === 'failed' ? null : 'failed')}
            className={cn(
              "h-11 sm:h-14 px-2 sm:px-4 flex flex-col items-center justify-center rounded-md transition-all font-mono",
              activeFilter === 'failed'
                ? "bg-red-600 text-white"
                : "bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400"
            )}
          >
            <span className="text-lg sm:text-2xl font-bold leading-none">{failedIos}</span>
            <span className="text-[9px] sm:text-[10px] uppercase tracking-wider font-sans opacity-80">Fail</span>
          </button>

          <button
            onClick={() => onFilterChange?.(activeFilter === 'not-tested' ? null : 'not-tested')}
            className={cn(
              "h-11 sm:h-14 px-2 sm:px-4 flex flex-col items-center justify-center rounded-md transition-all font-mono",
              activeFilter === 'not-tested'
                ? "bg-slate-600 text-white"
                : "bg-slate-500/10 hover:bg-slate-500/20 text-slate-600 dark:text-slate-400"
            )}
          >
            <span className="text-lg sm:text-2xl font-bold leading-none">{notTestedIos}</span>
            <span className="text-[9px] sm:text-[10px] uppercase tracking-wider font-sans opacity-80">Left</span>
          </button>

          <div className="w-px h-8 bg-border mx-0.5 sm:mx-1 hidden sm:block" />

          <button
            onClick={() => onFilterChange?.(activeFilter === 'inputs' ? null : 'inputs')}
            className={cn(
              "h-11 sm:h-14 px-2 sm:px-4 flex items-center justify-center rounded-md transition-all text-xs sm:text-sm font-medium",
              activeFilter === 'inputs'
                ? "bg-blue-600 text-white"
                : "bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400"
            )}
          >
            In
          </button>

          <button
            onClick={() => onFilterChange?.(activeFilter === 'outputs' ? null : 'outputs')}
            className={cn(
              "h-11 sm:h-14 px-2 sm:px-4 flex items-center justify-center rounded-md transition-all text-xs sm:text-sm font-medium",
              activeFilter === 'outputs'
                ? "bg-orange-600 text-white"
                : "bg-orange-500/10 hover:bg-orange-500/20 text-orange-600 dark:text-orange-400"
            )}
          >
            Out
          </button>
        </div>

        {/* Progress Bar - Flex grow to fill space */}
        <div className="flex-1 mx-1 sm:mx-4 min-w-[100px] sm:min-w-[200px] order-last sm:order-none w-full sm:w-auto">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-6 sm:h-8 bg-muted rounded-full overflow-hidden relative">
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
                <span className="text-xs sm:text-sm font-bold text-foreground drop-shadow-sm">
                  {Math.round(progressPercent)}% ({passedIos + failedIos}/{totalIos})
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Divider - hidden on mobile */}
        <div className="w-px h-10 bg-border hidden sm:block" />

        {/* Action Buttons */}
        <div className="flex items-center gap-0.5 sm:gap-1">
          <Button
            variant="ghost"
            size="lg"
            className="h-10 w-10 sm:h-12 sm:w-12 p-0"
            onClick={onShowGraph}
            title="Show Graph"
          >
            <BarChart3 className="w-5 h-5 sm:w-6 sm:h-6" />
          </Button>

          <Button
            variant="ghost"
            size="lg"
            className="h-10 w-10 sm:h-12 sm:w-12 p-0"
            data-tour="csv-export"
            onClick={onDownloadCsv}
            title="Export CSV"
          >
            <Download className="w-5 h-5 sm:w-6 sm:h-6" />
          </Button>


          <Button
            variant="ghost"
            size="lg"
            className="h-10 w-10 sm:h-12 sm:w-12 p-0"
            onClick={() => {
              if (subsystemId) {
                window.open(`/api/ios/report?subsystemId=${subsystemId}`, '_blank')
              }
            }}
            title="Generate Commissioning Report"
          >
            <FileText className="w-5 h-5 sm:w-6 sm:h-6" />
          </Button>

          <Button
            variant="ghost"
            size="lg"
            className="h-10 w-10 sm:h-12 sm:w-12 p-0"
            onClick={onShowHistory}
            title="Test History"
          >
            <History className="w-5 h-5 sm:w-6 sm:h-6" />
          </Button>

          <Button
            variant="ghost"
            size="lg"
            className="h-10 w-10 sm:h-12 sm:w-12 p-0"
            onClick={onShowChangeRequests}
            title="Change Requests"
          >
            <FileEdit className="w-5 h-5 sm:w-6 sm:h-6" />
          </Button>
        </div>

        {/* Divider - hidden on mobile */}
        <div className="w-px h-10 bg-border hidden sm:block" />

        {/* Status & Config */}
        <div className="flex items-center gap-0.5 sm:gap-1">
          {/* Simulator Toggle - Admin only */}
          {currentUser?.isAdmin && onToggleSimulator && (
            <Button
              variant={isSimulatorEnabled ? "default" : "ghost"}
              size="lg"
              className={cn(
                "h-10 w-10 sm:h-12 sm:w-auto sm:px-3 p-0 sm:p-auto",
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

          {/* PLC Status */}
          {currentUser?.isAdmin ? (
            <Button
              data-tour="plc-status"
              variant={isPlcConnected ? "ghost" : "outline"}
              size="lg"
              className={cn(
                "h-10 sm:h-12 px-2 sm:px-3 gap-1 sm:gap-2",
                isPlcConnected
                  ? "text-green-600"
                  : isPlcReconnecting
                  ? "text-amber-500 border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 animate-pulse"
                  : "text-red-600 border-red-500/50 bg-red-500/10 hover:bg-red-500/20 animate-pulse"
              )}
              onClick={onShowConfig}
              title={isPlcConnected ? "PLC Connected" : isPlcReconnecting ? "PLC Lost — Reconnecting..." : "PLC Disconnected — Click to configure"}
            >
              <Cpu className={cn("w-5 h-5", isPlcConnected && "status-pulse", isPlcReconnecting && "animate-spin")} />
              <span className="text-xs uppercase hidden sm:inline">
                {isPlcReconnecting ? "Reconnecting" : "PLC"}
              </span>
            </Button>
          ) : (
            <div
              data-tour="plc-status"
              className={cn(
                "h-10 sm:h-12 px-2 sm:px-3 gap-1 sm:gap-2 flex items-center rounded-md",
                isPlcConnected ? "text-green-600" : isPlcReconnecting ? "text-amber-500 animate-pulse" : "text-red-600"
              )}
              title={isPlcConnected ? "PLC Connected" : isPlcReconnecting ? "PLC Lost — Reconnecting..." : "PLC Disconnected"}
            >
              <Cpu className={cn("w-5 h-5", isPlcConnected && "status-pulse", isPlcReconnecting && "animate-spin")} />
            </div>
          )}

          {/* Tag Status Indicator */}
          {tagStatus && tagStatus.totalTags > 0 && (
            <Button
              variant={tagStatus.hasErrors ? "outline" : "ghost"}
              size="lg"
              className={cn(
                "h-10 sm:h-12 px-2 sm:px-3 gap-1 sm:gap-1.5",
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
          {currentUser && (
            <Button
              data-tour="cloud-status"
              variant="ghost"
              size="lg"
              className={cn(
                "h-10 w-10 sm:h-12 sm:w-auto sm:px-3 p-0 sm:p-auto gap-2",
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
          )}

          {/* Guide — interactive tour + static guide link */}
          <div className="flex items-center gap-0.5">
            {onStartTour && (
              <Button
                variant="outline"
                size="lg"
                className="h-10 sm:h-12 px-3 sm:px-4 bg-blue-500/10 border-blue-500/30 text-blue-500 hover:bg-blue-500/20 hover:text-blue-400 font-bold"
                title="Start Interactive Tour"
                onClick={onStartTour}
              >
                <HelpCircle className="w-4 h-4 mr-1.5" />
                <span className="text-xs sm:text-sm uppercase tracking-wide">Guide</span>
              </Button>
            )}
            <Link href="/guide" target="_blank">
              <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-12 sm:w-12 text-muted-foreground hover:text-foreground" title="Open Full Guide (new tab)">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
