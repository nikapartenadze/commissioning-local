"use client"

import { useState, useEffect, useCallback } from 'react'
import { L2SheetGrid } from './l2-sheet-grid'
import { Badge } from '@/components/ui/badge'
import { authFetch } from '@/lib/api-config'
import { cn } from '@/lib/utils'
import { Loader2, ClipboardCheck, Info, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface L2Sheet {
  id: number
  Name: string
  DisplayName: string
}

interface L2Column {
  id: number
  SheetId: number
  Name: string
  ColumnType: string
  DisplayOrder: number
}

interface L2Device {
  id: number
  SheetId: number
  DeviceName: string
  Mcm: string
  Subsystem: string
  CompletedChecks: number
  TotalChecks: number
}

interface L2CellValue {
  DeviceId: number
  ColumnId: number
  Value: string | null
  Version: number
}

interface L2Data {
  sheets: L2Sheet[]
  columns: L2Column[]
  devices: L2Device[]
  cellValues: L2CellValue[]
  hasData: boolean
}

interface L2ValidationViewProps {
  subsystemId?: number
}

export function L2ValidationView({ subsystemId }: L2ValidationViewProps) {
  const [data, setData] = useState<L2Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSheet, setActiveSheet] = useState(0)
  const [showGuide, setShowGuide] = useState(false)
  const [cellValues, setCellValues] = useState<Map<string, { Value: string | null; Version: number }>>(new Map())

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await authFetch('/api/l2')
      if (!res.ok) throw new Error(`Failed to fetch L2 data: ${res.status}`)
      const json: L2Data = await res.json()
      setData(json)

      // Build cell values map keyed by "deviceId-columnId"
      const map = new Map<string, { Value: string | null; Version: number }>()
      for (const cv of json.cellValues) {
        map.set(`${cv.DeviceId}-${cv.ColumnId}`, { Value: cv.Value, Version: cv.Version })
      }
      setCellValues(map)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load L2 data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleCellChange = useCallback(async (deviceId: number, columnId: number, value: string | null) => {
    const key = `${deviceId}-${columnId}`

    // Optimistic update
    setCellValues(prev => {
      const next = new Map(prev)
      const existing = prev.get(key)
      next.set(key, { Value: value, Version: (existing?.Version ?? 0) + 1 })
      return next
    })

    // Persist to API
    try {
      await authFetch('/api/l2/cell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, columnId, value }),
      })
    } catch (err) {
      console.error('Failed to save L2 cell value:', err)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading L2 validation data...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-destructive">
        {error}
      </div>
    )
  }

  if (!data || !data.hasData || data.sheets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
        <ClipboardCheck className="h-10 w-10 opacity-40" />
        <p className="text-sm">No L2 validation data. Pull from cloud to load.</p>
      </div>
    )
  }

  // Per-sheet stats
  const sheetStats = data.sheets.map(sheet => {
    const sheetDevices = data.devices.filter(d => d.SheetId === sheet.id)
    const sheetCols = data.columns.filter(c => c.SheetId === sheet.id && c.ColumnType === 'check')
    // Count completed checks from cellValues map
    let completed = 0
    for (const dev of sheetDevices) {
      for (const col of sheetCols) {
        const cv = cellValues.get(`${dev.id}-${col.id}`)
        if (cv?.Value && cv.Value !== '') completed++
      }
    }
    const total = sheetDevices.length * sheetCols.length
    return { total, completed, deviceCount: sheetDevices.length, colCount: sheetCols.length }
  })

  // Overall progress
  const totalChecks = sheetStats.reduce((sum, s) => sum + s.total, 0)
  const completedChecks = sheetStats.reduce((sum, s) => sum + s.completed, 0)
  const overallPercent = totalChecks > 0 ? Math.round((completedChecks / totalChecks) * 100) : 0

  const activeSheetData = data.sheets[activeSheet]
  const activeColumns = data.columns
    .filter(c => c.SheetId === activeSheetData.id)
    .sort((a, b) => a.DisplayOrder - b.DisplayOrder)
  const activeDevices = data.devices
    .filter(d => d.SheetId === activeSheetData.id)
    .sort((a, b) => a.DeviceName.localeCompare(b.DeviceName))

  return (
    <div className="flex flex-col h-full">
      {/* Header bar with progress + tabs + guide */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="text-xs font-medium text-muted-foreground whitespace-nowrap tabular-nums">
          {completedChecks}/{totalChecks} ({overallPercent}%)
        </span>
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${overallPercent}%` }} />
        </div>
        <Button
          variant={showGuide ? "default" : "outline"}
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={() => setShowGuide(!showGuide)}
        >
          <Info className="h-3 w-3" />
          Guide
        </Button>
      </div>

      {/* Sheet tabs */}
      <div className="flex gap-1 overflow-x-auto px-3 py-1.5 border-b shrink-0 bg-muted/30">
        {data.sheets.map((sheet, idx) => {
          const stats = sheetStats[idx]
          const isActive = idx === activeSheet
          return (
            <button
              key={sheet.id}
              onClick={() => setActiveSheet(idx)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors border",
                isActive
                  ? "bg-primary text-primary-foreground border-primary shadow-sm"
                  : "bg-card text-card-foreground border-border hover:bg-accent"
              )}
            >
              {sheet.Name}
              {stats.deviceCount > 0 && (
                <Badge variant={isActive ? "secondary" : "outline"} className="text-[10px] tabular-nums px-1">
                  {stats.deviceCount}
                </Badge>
              )}
            </button>
          )
        })}
      </div>

      {/* Guide panel (collapsible) */}
      {showGuide && (
        <div className="border-b bg-blue-50 dark:bg-blue-950/30 px-4 py-3 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold">Column Guide — {activeSheetData.DisplayName || activeSheetData.Name}</h4>
            <button onClick={() => setShowGuide(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {activeColumns.map(col => (
              <div key={col.id} className="flex items-start gap-2 text-xs">
                <Badge variant="outline" className={cn(
                  "shrink-0 text-[9px] px-1",
                  col.ColumnType === 'check' && "bg-green-100 text-green-700 border-green-300 dark:bg-green-900 dark:text-green-300",
                  col.ColumnType === 'data' && "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900 dark:text-blue-300",
                  col.ColumnType === 'readonly' && "bg-gray-100 text-gray-600 border-gray-300",
                  col.ColumnType === 'notes' && "bg-amber-100 text-amber-700 border-amber-300",
                )}>
                  {col.ColumnType}
                </Badge>
                <span className="text-foreground">{col.Name}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            <strong>check</strong> = tap to cycle pass/fail &nbsp; <strong>data</strong> = type value &nbsp; <strong>readonly</strong> = pre-filled &nbsp; <strong>notes</strong> = free text
          </p>
        </div>
      )}

      {/* Active sheet grid — takes all remaining space */}
      <div className="flex-1 min-h-0">
        {activeDevices.length > 0 ? (
          <L2SheetGrid
            sheet={activeSheetData}
            columns={activeColumns}
            devices={activeDevices}
            cellValues={cellValues}
            onCellChange={handleCellChange}
          />
        ) : (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            No devices in this sheet
          </div>
        )}
      </div>
    </div>
  )
}
