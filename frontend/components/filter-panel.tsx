"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { DateRangeFilter } from "@/components/date-range-filter"
import { TEST_CONSTANTS } from "@/lib/constants"
import { RotateCcw } from "lucide-react"

interface FilterPanelProps {
  resultFilters: Record<string, boolean>
  subsystemFilters: Record<string, boolean>
  subsystems: string[]
  onResultFilterChange: (filters: Record<string, boolean>) => void
  onSubsystemFilterChange: (filters: Record<string, boolean>) => void
  onDateRangeChange: (startDate: string, endDate: string) => void
}

export function FilterPanel({
  resultFilters,
  subsystemFilters,
  subsystems,
  onResultFilterChange,
  onSubsystemFilterChange,
  onDateRangeChange,
}: FilterPanelProps) {
  const resetFilters = () => {
    onResultFilterChange({
      [TEST_CONSTANTS.RESULT_PASSED]: true,
      [TEST_CONSTANTS.RESULT_FAILED]: true,
      [TEST_CONSTANTS.RESULT_NOT_TESTED]: true,
    })
    onSubsystemFilterChange(
      Object.fromEntries(subsystems.map(s => [s, true]))
    )
  }

  const allFiltersActive = 
    Object.values(resultFilters).every(v => v) && 
    Object.values(subsystemFilters).every(v => v)

  return (
    <div className="space-y-4 sticky top-20">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold">Filters</h3>
        {!allFiltersActive && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            <RotateCcw className="h-4 w-4 mr-1" />
            Reset
          </Button>
        )}
      </div>

      {/* Result Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Test Results</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="filter-passed"
              checked={resultFilters[TEST_CONSTANTS.RESULT_PASSED]}
              onCheckedChange={(checked) =>
                onResultFilterChange({
                  ...resultFilters,
                  [TEST_CONSTANTS.RESULT_PASSED]: !!checked,
                })
              }
              className="h-4 w-4"
            />
            <Label htmlFor="filter-passed" className="text-sm font-normal cursor-pointer">
              Passed
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="filter-failed"
              checked={resultFilters[TEST_CONSTANTS.RESULT_FAILED]}
              onCheckedChange={(checked) =>
                onResultFilterChange({
                  ...resultFilters,
                  [TEST_CONSTANTS.RESULT_FAILED]: !!checked,
                })
              }
              className="h-4 w-4"
            />
            <Label htmlFor="filter-failed" className="text-sm font-normal cursor-pointer">
              Failed
            </Label>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="filter-not-tested"
              checked={resultFilters[TEST_CONSTANTS.RESULT_NOT_TESTED]}
              onCheckedChange={(checked) =>
                onResultFilterChange({
                  ...resultFilters,
                  [TEST_CONSTANTS.RESULT_NOT_TESTED]: !!checked,
                })
              }
              className="h-4 w-4"
            />
            <Label htmlFor="filter-not-tested" className="text-sm font-normal cursor-pointer">
              Not Tested
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* Date Range Filter */}
      <DateRangeFilter onApplyDateRange={onDateRangeChange} />

      {/* Subsystem Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Subsystems</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 max-h-64 overflow-y-auto">
          {subsystems.map((subsystem) => (
            <div key={subsystem} className="flex items-center space-x-2">
              <Checkbox
                id={`filter-${subsystem}`}
                checked={subsystemFilters[subsystem]}
                onCheckedChange={(checked) =>
                  onSubsystemFilterChange({
                    ...subsystemFilters,
                    [subsystem]: !!checked,
                  })
                }
                className="h-4 w-4"
              />
              <Label
                htmlFor={`filter-${subsystem}`}
                className="text-sm font-normal cursor-pointer truncate"
                title={subsystem}
              >
                {subsystem}
              </Label>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

