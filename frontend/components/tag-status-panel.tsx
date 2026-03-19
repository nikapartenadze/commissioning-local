"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { ChevronDown, ChevronUp, AlertTriangle, CheckCircle, XCircle, RefreshCw } from "lucide-react"
import { API_ENDPOINTS, authFetch } from "@/lib/api-config"
import { cn } from "@/lib/utils"

interface TagStatus {
  plcConnected: boolean
  totalTags: number
  successfulTags: number
  failedTags: number
  successRate: number
  hasErrors: boolean
  notFoundTags: string[]
  illegalTags: string[]
  unknownErrorTags: string[]
  dintGroupFailures: string[]
  lastUpdated: string | null
  plcIp: string
  plcPath: string
}

export function TagStatusPanel({ className }: { className?: string }) {
  const [status, setStatus] = useState<TagStatus | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const fetchStatus = async () => {
    try {
      setIsLoading(true)
      const response = await authFetch(API_ENDPOINTS.tagStatus)
      if (response.ok) {
        const data = await response.json()
        setStatus(data)
        // Auto-expand if there are errors
        if (data.hasErrors && !isExpanded) {
          setIsExpanded(true)
        }
      }
    } catch (error) {
      console.error("Failed to fetch tag status:", error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
  }, [])

  if (!status) return null

  // Don't show if no errors and not expanded
  if (!status.hasErrors && !isExpanded) {
    return null
  }

  return (
    <div className={cn("bg-card border-b", className)}>
      {/* Header - Always visible when there are errors */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "w-full px-4 py-2 flex items-center justify-between text-left transition-colors",
          status.hasErrors
            ? "bg-red-500/10 hover:bg-red-500/20"
            : "bg-green-500/10 hover:bg-green-500/20"
        )}
      >
        <div className="flex items-center gap-3">
          {status.hasErrors ? (
            <AlertTriangle className="w-5 h-5 text-red-500" />
          ) : (
            <CheckCircle className="w-5 h-5 text-green-500" />
          )}
          <span className="font-semibold">
            {status.hasErrors
              ? `Tag Errors: ${status.failedTags} of ${status.totalTags} tags failed${status.dintGroupFailures?.length ? ` + ${status.dintGroupFailures.length} DINT group(s)` : ''}`
              : `All ${status.totalTags} tags connected`}
          </span>
          <span className="text-sm text-muted-foreground">
            ({status.plcIp} path {status.plcPath})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              fetchStatus()
            }}
            disabled={isLoading}
          >
            <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
          </Button>
          {isExpanded ? (
            <ChevronUp className="w-5 h-5" />
          ) : (
            <ChevronDown className="w-5 h-5" />
          )}
        </div>
      </button>

      {/* Expanded Details */}
      {isExpanded && status.hasErrors && (
        <div className="px-4 py-3 space-y-3 bg-muted/30">
          {/* Not Found Tags */}
          {status.notFoundTags.length > 0 && (
            <div>
              <h4 className="font-semibold text-red-600 flex items-center gap-2 mb-2">
                <XCircle className="w-4 h-4" />
                Not Found ({status.notFoundTags.length})
              </h4>
              <div className="flex flex-wrap gap-1">
                {status.notFoundTags.map((tag, i) => (
                  <code
                    key={i}
                    className="px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded text-xs font-mono"
                  >
                    {tag}
                  </code>
                ))}
              </div>
            </div>
          )}

          {/* Illegal Tags */}
          {status.illegalTags.length > 0 && (
            <div>
              <h4 className="font-semibold text-amber-600 flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4" />
                Module Fault/Offline ({status.illegalTags.length})
              </h4>
              <div className="flex flex-wrap gap-1">
                {status.illegalTags.map((tag, i) => (
                  <code
                    key={i}
                    className="px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded text-xs font-mono"
                  >
                    {tag}
                  </code>
                ))}
              </div>
            </div>
          )}

          {/* Unknown Errors */}
          {status.unknownErrorTags.length > 0 && (
            <div>
              <h4 className="font-semibold text-blue-600 flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4" />
                Other Errors ({status.unknownErrorTags.length})
              </h4>
              <div className="flex flex-wrap gap-1">
                {status.unknownErrorTags.map((tag, i) => (
                  <code
                    key={i}
                    className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded text-xs font-mono"
                  >
                    {tag}
                  </code>
                ))}
              </div>
            </div>
          )}

          {/* DINT Group Failures */}
          {status.dintGroupFailures?.length > 0 && (
            <div>
              <h4 className="font-semibold text-orange-600 flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4" />
                DINT Group Failures ({status.dintGroupFailures.length})
              </h4>
              <div className="flex flex-wrap gap-1">
                {status.dintGroupFailures.map((group, i) => (
                  <code
                    key={i}
                    className="px-2 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 rounded text-xs font-mono"
                  >
                    {group}
                  </code>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                These tags are read individually instead. Functionality is not affected.
              </p>
            </div>
          )}

          <p className="text-xs text-muted-foreground pt-2 border-t">
            These tags failed to connect. Check if the tag names exist in the PLC
            and if the PLC path is correct.
          </p>
        </div>
      )}
    </div>
  )
}
