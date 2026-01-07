"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DateRangeFilter } from "@/components/date-range-filter"
import { TEST_CONSTANTS } from "@/lib/constants"
import { RotateCcw, Filter, X, Calendar, CheckSquare } from "lucide-react"
import { cn } from "@/lib/utils"

interface MobileFilterDrawerProps {
  resultFilters: Record<string, boolean>
  subsystemFilters: Record<string, boolean>
  subsystems: string[]
  onResultFilterChange: (filters: Record<string, boolean>) => void
  onSubsystemFilterChange: (filters: Record<string, boolean>) => void
  onDateRangeChange: (startDate: string, endDate: string) => void
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

export function MobileFilterDrawer({
  resultFilters,
  subsystemFilters,
  subsystems,
  onResultFilterChange,
  onSubsystemFilterChange,
  onDateRangeChange,
  isOpen,
  onOpenChange,
}: MobileFilterDrawerProps) {
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

  const activeFilterCount = 
    Object.values(resultFilters).filter(v => !v).length +
    Object.values(subsystemFilters).filter(v => !v).length

  return (
    <>
      {/* Mobile Filter Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => onOpenChange(true)}
        className="lg:hidden relative"
      >
        <Filter className="h-4 w-4 mr-2" />
        Filters
        {activeFilterCount > 0 && (
          <Badge variant="destructive" className="ml-2 h-5 w-5 p-0 text-xs flex items-center justify-center">
            {activeFilterCount}
          </Badge>
        )}
      </Button>

      {/* Overlay */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-50 lg:hidden"
          onClick={() => onOpenChange(false)}
        />
      )}

      {/* Drawer */}
      <div className={cn(
        "fixed top-0 right-0 h-full w-80 bg-background border-l shadow-lg z-50 transform transition-transform duration-300 ease-in-out lg:hidden",
        isOpen ? "translate-x-0" : "translate-x-full"
      )}>
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b">
            <div className="flex items-center gap-2">
              <Filter className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Filters</h2>
              {activeFilterCount > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {activeFilterCount} active
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Quick Actions */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={resetFilters}
                disabled={allFiltersActive}
                className="flex-1"
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Reset All
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => onOpenChange(false)}
                className="flex-1"
              >
                Apply
              </Button>
            </div>

            {/* Result Filters */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <CheckSquare className="h-4 w-4" />
                  Test Results
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {Object.entries(resultFilters).map(([result, checked]) => (
                  <div key={result} className="flex items-center space-x-2">
                    <Checkbox
                      id={`mobile-filter-${result}`}
                      checked={checked}
                      onCheckedChange={(isChecked) =>
                        onResultFilterChange({
                          ...resultFilters,
                          [result]: !!isChecked,
                        })
                      }
                      className="h-4 w-4"
                    />
                    <Label
                      htmlFor={`mobile-filter-${result}`}
                      className="text-sm font-normal cursor-pointer flex-1"
                    >
                      {result}
                    </Label>
                  </div>
                ))}
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
                      id={`mobile-filter-${subsystem}`}
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
                      htmlFor={`mobile-filter-${subsystem}`}
                      className="text-sm font-normal cursor-pointer truncate flex-1"
                      title={subsystem}
                    >
                      {subsystem}
                    </Label>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  )
}
