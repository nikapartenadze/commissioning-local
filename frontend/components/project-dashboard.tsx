"use client"

import { useState, useMemo, useEffect, useCallback } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/theme-toggle"
import { UserMenu } from "@/components/user-menu"
import { IoDataGrid } from "@/components/io-data-grid"
import { TestResultsChart } from "@/components/test-results-chart"
import { FilterPanel } from "@/components/filter-panel"
import { MobileFilterDrawer } from "@/components/mobile-filter-drawer"
import { FilterChips } from "@/components/filter-chips"
import { QuickFilters } from "@/components/quick-filters"
import { AllTestHistoryDialog } from "@/components/all-test-history-dialog"
import { ArrowLeft, PieChart, Download, History } from "lucide-react"
import { isValidTestableItem } from "@/lib/utils"
import { TEST_CONSTANTS } from "@/lib/constants"

type IoWithSubsystem = {
  id: number
  name: string
  description: string | null
  result: string | null
  timestamp: string | null
  comments: string | null
  order: number | null
  subsystemName: string
  subsystemId: number
}

type Project = {
  id: number
  name: string
}

type Subsystem = {
  id: number
  name: string
}

interface ProjectDashboardProps {
  project: Project
  ios: IoWithSubsystem[]
  subsystems: Subsystem[]
}

export function ProjectDashboard({ project, ios, subsystems }: ProjectDashboardProps) {
  const [showChart, setShowChart] = useState(false)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [searchFilteredCount, setSearchFilteredCount] = useState(ios.length)
  const [finalFilteredIos, setFinalFilteredIos] = useState<IoWithSubsystem[]>([])
  const [dateRange, setDateRange] = useState({ start: "", end: "" })
  const [resultFilters, setResultFilters] = useState({
    [TEST_CONSTANTS.RESULT_PASSED]: true,
    [TEST_CONSTANTS.RESULT_FAILED]: true,
    [TEST_CONSTANTS.RESULT_NOT_TESTED]: true,
  })
  const [subsystemFilters, setSubsystemFilters] = useState<Record<string, boolean>>(
    Object.fromEntries(subsystems.map(s => [s.name, true]))
  )
  const [showMobileFilters, setShowMobileFilters] = useState(false)

  const filteredIos = useMemo(() => {
    return ios.filter(io => {
      // Filter by subsystem
      if (!subsystemFilters[io.subsystemName]) return false

      // Filter by result
      if (io.result === TEST_CONSTANTS.RESULT_PASSED && !resultFilters[TEST_CONSTANTS.RESULT_PASSED]) {
        return false
      }
      if (io.result === TEST_CONSTANTS.RESULT_FAILED && !resultFilters[TEST_CONSTANTS.RESULT_FAILED]) {
        return false
      }
      if ((!io.result || io.result === TEST_CONSTANTS.RESULT_NOT_TESTED) && 
          !resultFilters[TEST_CONSTANTS.RESULT_NOT_TESTED]) {
        return false
      }

      // Filter by date range
      if (dateRange.start || dateRange.end) {
        if (!io.timestamp) return false
        
        try {
          const ioDate = new Date(io.timestamp)
          
          if (dateRange.start) {
            const startDate = new Date(dateRange.start)
            if (ioDate < startDate) return false
          }
          
          if (dateRange.end) {
            const endDate = new Date(dateRange.end)
            endDate.setHours(23, 59, 59) // Include entire end date
            if (ioDate > endDate) return false
          }
        } catch {
          return false
        }
      }

      return true
    }).filter(isValidTestableItem)
  }, [ios, resultFilters, subsystemFilters, dateRange])

  // Chart data - will be passed from IoDataGrid after search filtering
  const [chartData, setChartData] = useState({
    passed: 0,
    failed: 0,
    notTested: 0,
    total: 0,
    passedPercent: 0,
    failedPercent: 0,
    notTestedPercent: 0,
  })

  // Calculate initial chart data from sidebar-filtered IOs
  useMemo(() => {
    const testableIos = filteredIos.filter(isValidTestableItem)
    const passed = testableIos.filter(io => io.result === TEST_CONSTANTS.RESULT_PASSED).length
    const failed = testableIos.filter(io => io.result === TEST_CONSTANTS.RESULT_FAILED).length
    const notTested = testableIos.filter(io => !io.result || io.result === TEST_CONSTANTS.RESULT_NOT_TESTED).length
    const total = passed + failed + notTested

    setChartData({
      passed,
      failed,
      notTested,
      total,
      passedPercent: total > 0 ? (passed / total) * 100 : 0,
      failedPercent: total > 0 ? (failed / total) * 100 : 0,
      notTestedPercent: total > 0 ? (notTested / total) * 100 : 0,
    })
  }, [filteredIos])

  // Callback to update chart when search filters change in IoDataGrid
  // Use useCallback to prevent infinite loops in child components
  const handleSearchFilteredDataChange = useCallback((searchFilteredIos: IoWithSubsystem[]) => {
    const testableIos = searchFilteredIos.filter(isValidTestableItem)
    const passed = testableIos.filter(io => io.result === TEST_CONSTANTS.RESULT_PASSED).length
    const failed = testableIos.filter(io => io.result === TEST_CONSTANTS.RESULT_FAILED).length
    const notTested = testableIos.filter(io => !io.result || io.result === TEST_CONSTANTS.RESULT_NOT_TESTED).length
    const total = passed + failed + notTested

    setChartData({
      passed,
      failed,
      notTested,
      total,
      passedPercent: total > 0 ? (passed / total) * 100 : 0,
      failedPercent: total > 0 ? (failed / total) * 100 : 0,
      notTestedPercent: total > 0 ? (notTested / total) * 100 : 0,
    })
    setSearchFilteredCount(searchFilteredIos.length)
    setFinalFilteredIos(searchFilteredIos) // Store for CSV export
  }, [])

  const handleExport = () => {
    // Export FINAL filtered data (sidebar + search filters) matching old C# app format
    const dataToExport = finalFilteredIos.length > 0 ? finalFilteredIos : filteredIos
    
    const csv = [
      [
        'Id', 'SubsystemId', 'Subsystem Name', 'Name', 'Description', 'Result', 'Timestamp', 'Comments', 'Order', 'Version',
        'Project Id', 'Project Name', 'ApiKey', // Project columns
        'IsOutput', 'HasResult', 'IsPassed', 'IsFailed' // Computed properties
      ],
      ...dataToExport.map(io => {
        const isOutput = io.name?.includes(':O.') || io.name?.includes('.O.') || io.name?.includes(':O:') || io.name?.includes('.Outputs.') || io.name?.endsWith('.DO') || io.name?.toLowerCase().includes('output') || false
        const hasResult = !!io.result
        const isPassed = io.result === TEST_CONSTANTS.RESULT_PASSED
        const isFailed = io.result === TEST_CONSTANTS.RESULT_FAILED
        
        return [
          io.id.toString(),
          io.subsystemId.toString(),
          io.subsystemName || '', // ← SUBSYSTEM NAME HERE!
          io.name || '',
          io.description || '',
          io.result || '',
          io.timestamp || '',
          io.comments || '',
          io.order?.toString() || '',
          '0', // Version
          project.id.toString(), // Project.Id
          project.name || '', // Project.Name
          '', // Project.ApiKey (excluded for security)
          isOutput.toString().toUpperCase(),
          hasResult.toString().toUpperCase(),
          isPassed.toString().toUpperCase(),
          isFailed.toString().toUpperCase()
        ]
      })
    ].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.name}-filtered-ios-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleShowAllHistory = () => {
    setShowAllHistory(true)
  }

  // Filter handlers
  const handleResultFilterRemove = (result: string) => {
    setResultFilters(prev => ({ ...prev, [result]: true }))
  }

  const handleSubsystemFilterRemove = (subsystem: string) => {
    setSubsystemFilters(prev => ({ ...prev, [subsystem]: true }))
  }

  const handleDateRangeClear = () => {
    setDateRange({ start: "", end: "" })
  }

  const handleClearAllFilters = () => {
    setResultFilters({
      [TEST_CONSTANTS.RESULT_PASSED]: true,
      [TEST_CONSTANTS.RESULT_FAILED]: true,
      [TEST_CONSTANTS.RESULT_NOT_TESTED]: true,
    })
    setSubsystemFilters(Object.fromEntries(subsystems.map(s => [s.name, true])))
    setDateRange({ start: "", end: "" })
  }

  // Quick filter handlers
  const handleShowPassed = () => {
    setResultFilters({
      [TEST_CONSTANTS.RESULT_PASSED]: true,
      [TEST_CONSTANTS.RESULT_FAILED]: false,
      [TEST_CONSTANTS.RESULT_NOT_TESTED]: false,
    })
  }

  const handleShowFailed = () => {
    setResultFilters({
      [TEST_CONSTANTS.RESULT_PASSED]: false,
      [TEST_CONSTANTS.RESULT_FAILED]: true,
      [TEST_CONSTANTS.RESULT_NOT_TESTED]: false,
    })
  }

  const handleShowNotTested = () => {
    setResultFilters({
      [TEST_CONSTANTS.RESULT_PASSED]: false,
      [TEST_CONSTANTS.RESULT_FAILED]: false,
      [TEST_CONSTANTS.RESULT_NOT_TESTED]: true,
    })
  }

  const handleShowAll = () => {
    setResultFilters({
      [TEST_CONSTANTS.RESULT_PASSED]: true,
      [TEST_CONSTANTS.RESULT_FAILED]: true,
      [TEST_CONSTANTS.RESULT_NOT_TESTED]: true,
    })
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 sm:gap-4">
              <Button variant="ghost" size="icon" onClick={() => window.history.back()}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="min-w-0 flex-1">
                <h1 className="text-xl sm:text-2xl font-bold truncate">{project.name}</h1>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  <span className="hidden sm:inline">
                    {filteredIos.length} IO{filteredIos.length !== 1 ? 's' : ''} • {chartData.passed} Passed • {chartData.failed} Failed • {chartData.notTested} Not Tested
                  </span>
                  <span className="sm:hidden">
                    {filteredIos.length} IO • {chartData.passed}P • {chartData.failed}F • {chartData.notTested}NT
                  </span>
                </p>
              </div>
            </div>
            
            <div className="flex items-center justify-between sm:justify-end gap-2">
              <div className="flex items-center gap-1 sm:gap-2">
                <Button variant="outline" size="icon" onClick={() => setShowChart(!showChart)} title="Test Results Chart">
                  <PieChart className="h-4 w-4 sm:h-5 sm:w-5" />
                </Button>
                <Button variant="outline" size="icon" onClick={handleExport} title="Export to CSV">
                  <Download className="h-4 w-4 sm:h-5 sm:w-5" />
                </Button>
                <Button variant="outline" size="icon" onClick={handleShowAllHistory} title="View All Test History">
                  <History className="h-4 w-4 sm:h-5 sm:w-5" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <UserMenu />
                <ThemeToggle />
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Chart Modal */}
      {showChart && (
        <TestResultsChart
          data={chartData}
          onClose={() => setShowChart(false)}
        />
      )}

      {/* All Test History Modal */}
      {showAllHistory && (
        <AllTestHistoryDialog
          open={showAllHistory}
          onOpenChange={setShowAllHistory}
          projectId={project.id}
          projectName={project.name}
        />
      )}

      {/* Main Content */}
      <div className="container mx-auto px-4 py-4 sm:py-6">
        <div className="flex gap-6">
          {/* Desktop Filter Sidebar */}
          <div className="hidden lg:block w-64 flex-shrink-0">
            <FilterPanel
              resultFilters={resultFilters}
              subsystemFilters={subsystemFilters}
              subsystems={subsystems.map(s => s.name)}
              onResultFilterChange={(filters) => setResultFilters(filters as typeof resultFilters)}
              onSubsystemFilterChange={setSubsystemFilters}
              onDateRangeChange={(start, end) => setDateRange({ start, end })}
            />
          </div>

          {/* Data Grid */}
          <div className="flex-1 min-w-0">
            {/* Mobile/Tablet Filter Controls */}
            <div className="lg:hidden space-y-3 mb-4">
              {/* Mobile Filter Button */}
              <MobileFilterDrawer
                resultFilters={resultFilters}
                subsystemFilters={subsystemFilters}
                subsystems={subsystems.map(s => s.name)}
                onResultFilterChange={(filters) => setResultFilters(filters as typeof resultFilters)}
                onSubsystemFilterChange={setSubsystemFilters}
                onDateRangeChange={(start, end) => setDateRange({ start, end })}
                isOpen={showMobileFilters}
                onOpenChange={setShowMobileFilters}
              />

              {/* Quick Filters */}
              <QuickFilters
                resultFilters={resultFilters}
                subsystemFilters={subsystemFilters}
                onShowPassed={handleShowPassed}
                onShowFailed={handleShowFailed}
                onShowNotTested={handleShowNotTested}
                onShowAll={handleShowAll}
              />

              {/* Filter Chips */}
              <FilterChips
                resultFilters={resultFilters}
                subsystemFilters={subsystemFilters}
                dateRange={dateRange}
                onResultFilterRemove={handleResultFilterRemove}
                onSubsystemFilterRemove={handleSubsystemFilterRemove}
                onDateRangeClear={handleDateRangeClear}
                onClearAll={handleClearAllFilters}
              />
            </div>

            <IoDataGrid 
              ios={filteredIos as any} 
              projectId={project.id}
              onFilteredDataChange={handleSearchFilteredDataChange as any}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

