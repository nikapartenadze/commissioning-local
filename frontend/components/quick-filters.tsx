"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CheckSquare, X, Calendar, Settings } from "lucide-react"
import { TEST_CONSTANTS } from "@/lib/constants"

interface QuickFiltersProps {
  resultFilters: Record<string, boolean>
  subsystemFilters: Record<string, boolean>
  onShowPassed: () => void
  onShowFailed: () => void
  onShowNotTested: () => void
  onShowAll: () => void
}

export function QuickFilters({
  resultFilters,
  subsystemFilters,
  onShowPassed,
  onShowFailed,
  onShowNotTested,
  onShowAll,
}: QuickFiltersProps) {
  const allResultsActive = Object.values(resultFilters).every(Boolean)

  return (
    <div className="flex flex-wrap items-center gap-2 p-3 bg-muted/20 rounded-lg">
      <div className="flex items-center gap-1 text-sm text-muted-foreground mr-2">
        <span>Quick filters:</span>
      </div>

      {/* Result Filters Only */}
      <div className="flex items-center gap-1">
        <Button
          variant={allResultsActive ? "default" : "outline"}
          size="sm"
          onClick={onShowAll}
          className="h-8 px-3 text-xs"
        >
          <CheckSquare className="h-3 w-3 mr-1" />
          All
        </Button>
        
        <Button
          variant={resultFilters[TEST_CONSTANTS.RESULT_PASSED] && !allResultsActive ? "default" : "outline"}
          size="sm"
          onClick={onShowPassed}
          className="h-8 px-3 text-xs"
        >
          Passed
        </Button>
        
        <Button
          variant={resultFilters[TEST_CONSTANTS.RESULT_FAILED] && !allResultsActive ? "default" : "outline"}
          size="sm"
          onClick={onShowFailed}
          className="h-8 px-3 text-xs"
        >
          Failed
        </Button>
        
        <Button
          variant={resultFilters[TEST_CONSTANTS.RESULT_NOT_TESTED] && !allResultsActive ? "default" : "outline"}
          size="sm"
          onClick={onShowNotTested}
          className="h-8 px-3 text-xs"
        >
          Not Tested
        </Button>
      </div>
    </div>
  )
}
