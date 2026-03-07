"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  AlertTriangle,
  XCircle,
  HelpCircle,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  X
} from "lucide-react"
import { cn } from "@/lib/utils"
import { getApiBaseUrl } from "@/lib/api-config"

interface TagErrors {
  notFoundTags: string[]
  illegalTags: string[]
  unknownTags: string[]
  hasErrors: boolean
  totalErrors: number
}

interface TagErrorsPanelProps {
  onClose?: () => void
  autoRefresh?: boolean
  refreshInterval?: number
}

export function TagErrorsPanel({
  onClose,
  autoRefresh = false,
  refreshInterval = 10000
}: TagErrorsPanelProps) {
  const [errors, setErrors] = useState<TagErrors | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({
    notFound: true,
    illegal: true,
    unknown: true
  })

  const fetchErrors = async () => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/tag-errors`)
      if (response.ok) {
        const data = await response.json()
        setErrors(data)
      }
    } catch (error) {
      console.error("Failed to fetch tag errors:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchErrors()

    if (autoRefresh) {
      const interval = setInterval(fetchErrors, refreshInterval)
      return () => clearInterval(interval)
    }
  }, [autoRefresh, refreshInterval])

  if (loading) {
    return (
      <Card className="w-full">
        <CardContent className="p-6 text-center text-muted-foreground">
          Loading tag errors...
        </CardContent>
      </Card>
    )
  }

  if (!errors || !errors.hasErrors) {
    return (
      <Card className="w-full border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
            <span className="text-lg">All tags validated successfully</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={fetchErrors}>
              <RefreshCw className="w-4 h-4" />
            </Button>
            {onClose && (
              <Button variant="ghost" size="sm" onClick={onClose}>
                <X className="w-4 h-4" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="w-full border-red-200 dark:border-red-800">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertTriangle className="w-5 h-5" />
            Tag Validation Errors
            <Badge variant="destructive" className="ml-2">
              {errors.totalErrors} error{errors.totalErrors !== 1 ? 's' : ''}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={fetchErrors}>
              <RefreshCw className="w-4 h-4" />
            </Button>
            {onClose && (
              <Button variant="ghost" size="sm" onClick={onClose}>
                <X className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Not Found Tags */}
        {errors.notFoundTags.length > 0 && (
          <div className="border rounded-lg overflow-hidden">
            <button
              className="w-full flex items-center justify-between p-3 bg-red-100 dark:bg-red-900/30 text-left"
              onClick={() => setExpanded(prev => ({ ...prev, notFound: !prev.notFound }))}
            >
              <div className="flex items-center gap-2">
                <XCircle className="w-4 h-4 text-red-600 dark:text-red-400" />
                <span className="font-medium text-red-700 dark:text-red-300">
                  Missing Tags ({errors.notFoundTags.length})
                </span>
              </div>
              {expanded.notFound ? (
                <ChevronUp className="w-4 h-4 text-red-600" />
              ) : (
                <ChevronDown className="w-4 h-4 text-red-600" />
              )}
            </button>
            {expanded.notFound && (
              <div className="p-3 bg-red-50 dark:bg-red-950/30">
                <p className="text-sm text-red-600 dark:text-red-400 mb-2">
                  These tags don't exist in the PLC or have incorrect paths:
                </p>
                <ul className="space-y-1 max-h-40 overflow-y-auto">
                  {errors.notFoundTags.map((tag, idx) => (
                    <li
                      key={idx}
                      className="text-sm font-mono bg-white dark:bg-gray-800 px-2 py-1 rounded border border-red-200 dark:border-red-800"
                    >
                      {tag}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Illegal Tags (Module Fault/Offline) */}
        {errors.illegalTags.length > 0 && (
          <div className="border rounded-lg overflow-hidden">
            <button
              className="w-full flex items-center justify-between p-3 bg-orange-100 dark:bg-orange-900/30 text-left"
              onClick={() => setExpanded(prev => ({ ...prev, illegal: !prev.illegal }))}
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                <span className="font-medium text-orange-700 dark:text-orange-300">
                  Module Fault/Offline ({errors.illegalTags.length})
                </span>
              </div>
              {expanded.illegal ? (
                <ChevronUp className="w-4 h-4 text-orange-600" />
              ) : (
                <ChevronDown className="w-4 h-4 text-orange-600" />
              )}
            </button>
            {expanded.illegal && (
              <div className="p-3 bg-orange-50 dark:bg-orange-950/30">
                <p className="text-sm text-orange-600 dark:text-orange-400 mb-2">
                  These tags have fault values (not 0 or 1) - likely offline modules:
                </p>
                <ul className="space-y-1 max-h-40 overflow-y-auto">
                  {errors.illegalTags.map((tag, idx) => (
                    <li
                      key={idx}
                      className="text-sm font-mono bg-white dark:bg-gray-800 px-2 py-1 rounded border border-orange-200 dark:border-orange-800"
                    >
                      {tag}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Unknown/Other Errors */}
        {errors.unknownTags.length > 0 && (
          <div className="border rounded-lg overflow-hidden">
            <button
              className="w-full flex items-center justify-between p-3 bg-blue-100 dark:bg-blue-900/30 text-left"
              onClick={() => setExpanded(prev => ({ ...prev, unknown: !prev.unknown }))}
            >
              <div className="flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span className="font-medium text-blue-700 dark:text-blue-300">
                  Other Errors ({errors.unknownTags.length})
                </span>
              </div>
              {expanded.unknown ? (
                <ChevronUp className="w-4 h-4 text-blue-600" />
              ) : (
                <ChevronDown className="w-4 h-4 text-blue-600" />
              )}
            </button>
            {expanded.unknown && (
              <div className="p-3 bg-blue-50 dark:bg-blue-950/30">
                <p className="text-sm text-blue-600 dark:text-blue-400 mb-2">
                  These tags failed validation with other errors:
                </p>
                <ul className="space-y-1 max-h-40 overflow-y-auto">
                  {errors.unknownTags.map((tag, idx) => (
                    <li
                      key={idx}
                      className="text-sm font-mono bg-white dark:bg-gray-800 px-2 py-1 rounded border border-blue-200 dark:border-blue-800"
                    >
                      {tag}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Action Required */}
        <div className="p-3 bg-blue-100 dark:bg-blue-900/30 border-l-4 border-blue-500 rounded">
          <p className="font-medium text-blue-700 dark:text-blue-300">Action Required</p>
          <p className="text-sm text-blue-600 dark:text-blue-400 mt-1">
            Please fix these tag definitions in the cloud dashboard or verify your PLC configuration before proceeding.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
