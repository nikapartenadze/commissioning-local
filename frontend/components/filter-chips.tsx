"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { X, Calendar, CheckSquare, Settings } from "lucide-react"
import { TEST_CONSTANTS } from "@/lib/constants"

interface FilterChipsProps {
  resultFilters: Record<string, boolean>
  subsystemFilters: Record<string, boolean>
  dateRange: { start: string; end: string }
  onResultFilterRemove: (result: string) => void
  onSubsystemFilterRemove: (subsystem: string) => void
  onDateRangeClear: () => void
  onClearAll: () => void
}

export function FilterChips({
  resultFilters,
  subsystemFilters,
  dateRange,
  onResultFilterRemove,
  onSubsystemFilterRemove,
  onDateRangeClear,
  onClearAll,
}: FilterChipsProps) {
  const activeFilters = []

  // Add inactive result filters
  Object.entries(resultFilters).forEach(([result, active]) => {
    if (!active) {
      activeFilters.push({
        type: 'result',
        label: result,
        value: result,
        onRemove: () => onResultFilterRemove(result)
      })
    }
  })

  // Add inactive subsystem filters
  Object.entries(subsystemFilters).forEach(([subsystem, active]) => {
    if (!active) {
      activeFilters.push({
        type: 'subsystem',
        label: subsystem,
        value: subsystem,
        onRemove: () => onSubsystemFilterRemove(subsystem)
      })
    }
  })

  // Add date range filter if active
  if (dateRange.start || dateRange.end) {
    const startDate = dateRange.start ? new Date(dateRange.start).toLocaleDateString() : 'Start'
    const endDate = dateRange.end ? new Date(dateRange.end).toLocaleDateString() : 'End'
    activeFilters.push({
      type: 'date',
      label: `${startDate} - ${endDate}`,
      value: 'date-range',
      onRemove: onDateRangeClear
    })
  }

  if (activeFilters.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-2 p-3 bg-muted/30 rounded-lg">
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Settings className="h-4 w-4" />
        <span>Active filters:</span>
      </div>
      
      {activeFilters.map((filter) => (
        <Badge
          key={`${filter.type}-${filter.value}`}
          variant="secondary"
          className="gap-1 pr-1 text-xs font-normal"
        >
          {filter.type === 'result' && <CheckSquare className="h-3 w-3" />}
          {filter.type === 'subsystem' && <Settings className="h-3 w-3" />}
          {filter.type === 'date' && <Calendar className="h-3 w-3" />}
          {filter.label}
          <button
            onClick={filter.onRemove}
            className="ml-1 hover:bg-muted-foreground/20 rounded-full p-0.5"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      
      {activeFilters.length > 1 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearAll}
          className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Clear all
        </Button>
      )}
    </div>
  )
}
