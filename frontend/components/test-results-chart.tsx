"use client"

import { useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { X } from "lucide-react"
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts"
import { CHART_COLORS } from "@/lib/constants"

interface ChartData {
  passed: number
  failed: number
  notTested: number
  total: number
  passedPercent: number
  failedPercent: number
  notTestedPercent: number
}

interface TestResultsChartProps {
  data: ChartData
  onClose: () => void
}

export function TestResultsChart({ data, onClose }: TestResultsChartProps) {
  const chartData = [
    { name: 'Passed', value: data.passed, color: CHART_COLORS.passed },
    { name: 'Failed', value: data.failed, color: CHART_COLORS.failed },
    { name: 'Not Tested', value: data.notTested, color: CHART_COLORS.notTested },
  ].filter(item => item.value > 0)

  // Close on ESC key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <Card className="w-full max-w-2xl">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Test Results Overview</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <div className="h-64 sm:h-96">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(1)}%`}
                  outerRadius={120}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => `${value} IOs`} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-4 mt-4 sm:mt-6">
            <Card className="bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-900">
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {data.passed}
                </div>
                <div className="text-sm text-muted-foreground">
                  Passed ({data.passedPercent.toFixed(1)}%)
                </div>
              </CardContent>
            </Card>
            <Card className="bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900">
              <CardContent className="pt-6">
                <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                  {data.failed}
                </div>
                <div className="text-sm text-muted-foreground">
                  Failed ({data.failedPercent.toFixed(1)}%)
                </div>
              </CardContent>
            </Card>
            <Card className="bg-muted">
              <CardContent className="pt-6">
                <div className="text-2xl font-bold">
                  {data.notTested}
                </div>
                <div className="text-sm text-muted-foreground">
                  Not Tested ({data.notTestedPercent.toFixed(1)}%)
                </div>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

