"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { AlertTriangle, CheckCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { getApiBaseUrl } from "@/lib/api-config"
import { TagErrorsPanel } from "./tag-errors-panel"

interface TagErrors {
  notFoundTags: string[]
  illegalTags: string[]
  unknownTags: string[]
  hasErrors: boolean
  totalErrors: number
}

interface TagErrorIndicatorProps {
  className?: string
  refreshInterval?: number
  isPlcConnected?: boolean
  isTesting?: boolean
}

export function TagErrorIndicator({
  className,
  refreshInterval = 5000,
  isPlcConnected = false,
  isTesting = false
}: TagErrorIndicatorProps) {
  const [errors, setErrors] = useState<TagErrors | null>(null)
  const [open, setOpen] = useState(false)

  const fetchErrors = async () => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/tag-errors`)
      if (response.ok) {
        const data = await response.json()
        setErrors(data)
      }
    } catch (error) {
      // Silently fail - connection might not be available yet
    }
  }

  useEffect(() => {
    // Only fetch errors when PLC is connected and testing
    if (isPlcConnected && isTesting) {
      fetchErrors()
      const interval = setInterval(fetchErrors, refreshInterval)
      return () => clearInterval(interval)
    }
  }, [refreshInterval, isPlcConnected, isTesting])

  // Don't show anything if PLC not connected or not testing
  if (!isPlcConnected || !isTesting || !errors) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "relative min-w-[40px] transition-colors",
            errors.hasErrors
              ? "text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
              : "text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950",
            className
          )}
          title={errors.hasErrors ? `${errors.totalErrors} tag error(s)` : "All tags OK"}
        >
          {errors.hasErrors ? (
            <>
              <AlertTriangle className="w-5 h-5" />
              <Badge
                variant="destructive"
                className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]"
              >
                {errors.totalErrors}
              </Badge>
            </>
          ) : (
            <CheckCircle className="w-5 h-5" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[500px] p-0" align="end">
        <TagErrorsPanel onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
