"use client"

import { useState, useEffect, useCallback } from 'react'
import { L2SheetGrid } from './l2-sheet-grid'
import { Badge } from '@/components/ui/badge'
import { API_ENDPOINTS, authFetch } from '@/lib/api-config'
import { cn } from '@/lib/utils'
import { Loader2, ClipboardCheck } from 'lucide-react'

interface L2Sheet {
  id: number
  Name: string
  DisplayName: string
}

interface L2Column {
  id: number
  Name: string
  ColumnType: string
  DisplayOrder: number
  l2SheetId: number
}

interface L2Device {
  id: number
  DeviceName: string
  Mcm: string
  Subsystem: string
  CompletedChecks: number
  TotalChecks: number
  l2SheetId: number
}

interface L2CellValue {
  Value: string | null
  Version: number
  l2DeviceId: number
  l2ColumnId: number
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
  const [cellValues, setCellValues] = useState<Map<string, { Value: string | null; Version: number }>>(new Map())

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const url = subsystemId ? `/api/l2?subsystemId=${subsystemId}` : '/api/l2'
      const res = await authFetch(url)
      if (!res.ok) throw new Error(`Failed to fetch L2 data: ${res.status}`)
      const json: L2Data = await res.json()
      setData(json)

      // Build cell values map
      const map = new Map<string, { Value: string | null; Version: number }>()
      for (const cv of json.cellValues) {
        map.set(`${cv.l2DeviceId}-${cv.l2ColumnId}`, { Value: cv.Value, Version: cv.Version })
      }
      setCellValues(map)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load L2 data')
    } finally {
      setLoading(false)
    }
  }, [subsystemId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleCellChange = useCallback(async (deviceId: number, columnId: number, value: string | null) => {
    const key = `${deviceId}-${columnId}`
    const existing = cellValues.get(key)
    const newVersion = (existing?.Version ?? 0) + 1

    // Optimistic update
    setCellValues(prev => {
      const next = new Map(prev)
      next.set(key, { Value: value, Version: newVersion })
      return next
    })

    // Update device completed checks locally
    setData(prev => {
      if (!prev) return prev
      const devices = prev.devices.map(d => {
        if (d.id !== deviceId) return d
        // Find all check columns for this device's sheet
        const sheetCols = prev.columns.filter(c => c.l2SheetId === prev.sheets.find(s =>
          prev.devices.filter(dev => dev.l2SheetId === s.id).some(dev => dev.id === deviceId)
        )?.id && c.ColumnType === 'check')

        let completed = 0
        for (const col of sheetCols) {
          const k = `${deviceId}-${col.id}`
          if (k === key) {
            if (value) completed++
          } else {
            const cv = cellValues.get(k)
            if (cv?.Value) completed++
          }
        }
        return { ...d, CompletedChecks: completed }
      })
      return { ...prev, devices }
    })

    // Persist to API
    try {
      await authFetch('/api/l2/cell', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, columnId, value, version: newVersion }),
      })
    } catch (err) {
      console.error('Failed to save L2 cell value:', err)
    }
  }, [cellValues])

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

  // Compute overall progress
  const totalChecks = data.devices.reduce((sum, d) => sum + d.TotalChecks, 0)
  const completedChecks = data.devices.reduce((sum, d) => sum + d.CompletedChecks, 0)
  const overallPercent = totalChecks > 0 ? Math.round((completedChecks / totalChecks) * 100) : 0

  // Per-sheet stats
  const sheetStats = data.sheets.map(sheet => {
    const sheetDevices = data.devices.filter(d => d.l2SheetId === sheet.id)
    const total = sheetDevices.reduce((sum, d) => sum + d.TotalChecks, 0)
    const completed = sheetDevices.reduce((sum, d) => sum + d.CompletedChecks, 0)
    return { total, completed, deviceCount: sheetDevices.length }
  })

  const activeSheetData = data.sheets[activeSheet]
  const activeColumns = data.columns
    .filter(c => c.l2SheetId === activeSheetData.id)
    .sort((a, b) => a.DisplayOrder - b.DisplayOrder)
  const activeDevices = data.devices.filter(d => d.l2SheetId === activeSheetData.id)

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Overall progress */}
      <div className="flex items-center gap-3 px-1">
        <span className="text-sm font-medium text-muted-foreground whitespace-nowrap">
          {completedChecks} / {totalChecks} checks ({overallPercent}%)
        </span>
        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: `${overallPercent}%` }}
          />
        </div>
      </div>

      {/* Sheet tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 px-1 scrollbar-thin">
        {data.sheets.map((sheet, idx) => {
          const stats = sheetStats[idx]
          const isActive = idx === activeSheet
          return (
            <button
              key={sheet.id}
              onClick={() => setActiveSheet(idx)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors border",
                isActive
                  ? "bg-primary text-primary-foreground border-primary shadow-sm"
                  : "bg-card text-card-foreground border-border hover:bg-accent hover:text-accent-foreground"
              )}
            >
              {sheet.DisplayName || sheet.Name}
              <Badge
                variant={isActive ? "secondary" : "outline"}
                className="text-xs tabular-nums"
              >
                {stats.completed}/{stats.total}
              </Badge>
            </button>
          )
        })}
      </div>

      {/* Active sheet grid */}
      <div className="flex-1 min-h-0">
        <L2SheetGrid
          sheet={activeSheetData}
          columns={activeColumns}
          devices={activeDevices}
          cellValues={cellValues}
          onCellChange={handleCellChange}
        />
      </div>
    </div>
  )
}
