"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Calendar } from "lucide-react"

interface DateRangeFilterProps {
  onApplyDateRange: (startDate: string, endDate: string) => void
}

export function DateRangeFilter({ onApplyDateRange }: DateRangeFilterProps) {
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")

  const handleApply = () => {
    if (startDate || endDate) {
      // Format dates to match timestamp format (MM/DD/YY)
      const formattedStart = startDate ? formatDateForFilter(startDate) : ""
      const formattedEnd = endDate ? formatDateForFilter(endDate) : ""
      onApplyDateRange(formattedStart, formattedEnd)
    }
  }

  const handleClear = () => {
    setStartDate("")
    setEndDate("")
    onApplyDateRange("", "")
  }

  const formatDateForFilter = (dateString: string): string => {
    const date = new Date(dateString)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const year = String(date.getFullYear()).slice(-2)
    return `${month}/${day}/${year}`
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          Date Range
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="start-date" className="text-xs">From</Label>
          <Input
            id="start-date"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="text-xs h-10"
            style={{ 
              WebkitAppearance: 'none',
              MozAppearance: 'textfield'
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="end-date" className="text-xs">To</Label>
          <Input
            id="end-date"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="text-xs h-10"
            style={{ 
              WebkitAppearance: 'none',
              MozAppearance: 'textfield'
            }}
          />
        </div>
        <div className="flex gap-2">
          <Button 
            size="sm" 
            onClick={handleApply}
            className="flex-1 text-xs"
            disabled={!startDate && !endDate}
          >
            Apply
          </Button>
          <Button 
            size="sm" 
            variant="outline"
            onClick={handleClear}
            className="flex-1 text-xs"
          >
            Clear
          </Button>
        </div>
        {(startDate || endDate) && (
          <p className="text-xs text-muted-foreground">
            {startDate && `From: ${formatDateForFilter(startDate)}`}
            {startDate && endDate && <br />}
            {endDate && `To: ${formatDateForFilter(endDate)}`}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

