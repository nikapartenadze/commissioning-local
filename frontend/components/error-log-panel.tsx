"use client"

import { useState } from "react"
import { AlertTriangle, XCircle, Info, ChevronDown, ChevronUp, X, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ErrorEvent } from "@/lib/signalr-client"

interface ErrorLogPanelProps {
  errors: ErrorEvent[]
  onClear: () => void
  className?: string
}

export function ErrorLogPanel({ errors, onClear, className }: ErrorLogPanelProps) {
  const [expanded, setExpanded] = useState(false)

  if (errors.length === 0) return null

  const errorCount = errors.filter(e => e.severity === 'error').length
  const warningCount = errors.filter(e => e.severity === 'warning').length
  const latestError = errors[0]

  const getSeverityIcon = (severity: ErrorEvent['severity']) => {
    switch (severity) {
      case 'error': return <XCircle className="h-4 w-4 text-red-500 shrink-0" />
      case 'warning': return <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
      case 'info': return <Info className="h-4 w-4 text-blue-500 shrink-0" />
    }
  }

  const getSeverityBg = (severity: ErrorEvent['severity']) => {
    switch (severity) {
      case 'error': return 'bg-red-500/10 border-red-500/30'
      case 'warning': return 'bg-yellow-500/10 border-yellow-500/30'
      case 'info': return 'bg-blue-500/10 border-blue-500/30'
    }
  }

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const sourceLabel = (source: string) => {
    switch (source) {
      case 'plc': return 'PLC'
      case 'cloud': return 'Cloud'
      case 'tags': return 'Tags'
      case 'signalr': return 'Connection'
      case 'websocket': return 'Connection'
      case 'system': return 'System'
      default: return source
    }
  }

  return (
    <div className={cn("rounded-lg border overflow-hidden", errorCount > 0 ? "border-red-500/40 bg-red-500/5" : "border-yellow-500/40 bg-yellow-500/5", className)}>
      {/* Collapsed bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {getSeverityIcon(latestError.severity)}
          <span className="text-sm font-medium truncate">{latestError.message}</span>
          <span className="text-xs text-muted-foreground shrink-0">
            [{sourceLabel(latestError.source)}]
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {errorCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-600 dark:text-red-400 font-medium">
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          )}
          {warningCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 font-medium">
              {warningCount} {warningCount === 1 ? 'warning' : 'warnings'}
            </span>
          )}
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onClear() }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onClear() }}}
            className="p-1 hover:bg-muted rounded cursor-pointer"
            title="Clear all"
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>

      {/* Expanded log */}
      {expanded && (
        <div className="border-t max-h-48 overflow-y-auto">
          {errors.map((error, i) => (
            <div
              key={i}
              className={cn(
                "flex items-start gap-2 px-3 py-1.5 text-sm border-b last:border-b-0",
                getSeverityBg(error.severity)
              )}
            >
              {getSeverityIcon(error.severity)}
              <span className="text-xs text-muted-foreground font-mono shrink-0 pt-0.5">
                {formatTime(error.timestamp)}
              </span>
              <span className="text-xs font-medium text-muted-foreground shrink-0 pt-0.5">
                [{sourceLabel(error.source)}]
              </span>
              <span className="text-sm">{error.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
