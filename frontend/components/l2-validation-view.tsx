"use client"

import { useState, useEffect, useCallback, useRef } from 'react'
import { L2SheetGrid } from './l2-sheet-grid'
import { L2OverviewMatrix } from './l2-overview-matrix'
import { Badge } from '@/components/ui/badge'
import { authFetch, getSignalRHubUrl } from '@/lib/api-config'
import { cn } from '@/lib/utils'
import { Loader2, ClipboardCheck, Info, X, PanelRightClose, GripVertical, LayoutGrid, Table2, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUser } from '@/lib/user-context'
import { useSignalR, L2CellUpdate } from '@/lib/signalr-client'

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
  Description?: string | null
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

const COL_TYPE_STYLES: Record<string, string> = {
  check: "bg-green-100 text-green-700 border-green-300 dark:bg-green-900 dark:text-green-300",
  data: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900 dark:text-blue-300",
  readonly: "bg-gray-100 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-400",
  notes: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900 dark:text-amber-300",
}

const COL_TYPE_HINTS: Record<string, string> = {
  check: "Tap to cycle: pass / fail / empty",
  data: "Type a measured or observed value",
  readonly: "Pre-filled (cannot edit)",
  notes: "Free-text notes or comments",
}

const MIN_SIDEBAR_W = 240
const MAX_SIDEBAR_W = 600
const DEFAULT_SIDEBAR_W = 320

export function L2ValidationView({ subsystemId }: L2ValidationViewProps) {
  const { currentUser } = useUser()
  const [data, setData] = useState<L2Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeSheet, setActiveSheet] = useState(0)
  const [showGuide, setShowGuide] = useState(false)
  const [viewMode, setViewMode] = useState<'sheets' | 'overview'>('sheets')
  const [cellValues, setCellValues] = useState<Map<string, { Value: string | null; Version: number }>>(new Map())
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_W)
  const [resizingSidebar, setResizingSidebar] = useState<{ startX: number; startW: number } | null>(null)
  const [isNarrow, setIsNarrow] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Detect narrow viewport (tablet)
  useEffect(() => {
    const check = () => setIsNarrow(window.innerWidth < 1024)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Sidebar resize drag
  useEffect(() => {
    if (!resizingSidebar) return
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const delta = resizingSidebar.startX - clientX
      setSidebarWidth(Math.max(MIN_SIDEBAR_W, Math.min(MAX_SIDEBAR_W, resizingSidebar.startW + delta)))
    }
    const onUp = () => setResizingSidebar(null)

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove)
    document.addEventListener('touchend', onUp)
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
    }
  }, [resizingSidebar])

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await authFetch('/api/l2')
      if (!res.ok) throw new Error(`Failed to fetch L2 data: ${res.status}`)
      const json: L2Data = await res.json()
      setData(json)

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

  useEffect(() => { fetchData() }, [fetchData])

  // Subscribe to live L2 cell updates pushed from the cloud via WebSocket.
  // The local SSE client writes incoming changes to SQLite and broadcasts
  // an L2CellUpdated message; we merge it into local state so testers see
  // remote edits without refreshing.
  const signalR = useSignalR(getSignalRHubUrl())
  useEffect(() => {
    const handleL2Update = (update: L2CellUpdate) => {
      const key = `${update.localDeviceId}-${update.localColumnId}`
      setCellValues(prev => {
        const existing = prev.get(key)
        // Only apply if incoming version is newer — avoids clobbering
        // unsaved local edits whose optimistic version is ahead.
        if (existing && existing.Version >= update.version) {
          return prev
        }
        const next = new Map(prev)
        next.set(key, { Value: update.value, Version: update.version })
        return next
      })
    }
    signalR.onL2CellUpdate(handleL2Update)
    return () => {
      signalR.offL2CellUpdate(handleL2Update)
    }
  }, [signalR.onL2CellUpdate, signalR.offL2CellUpdate])

  const handleCellChange = useCallback(async (deviceId: number, columnId: number, value: string | null) => {
    const key = `${deviceId}-${columnId}`
    setCellValues(prev => {
      const next = new Map(prev)
      const existing = prev.get(key)
      next.set(key, { Value: value, Version: (existing?.Version ?? 0) + 1 })
      return next
    })
    try {
      await authFetch('/api/l2/cell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, columnId, value, updatedBy: currentUser?.fullName || localStorage.getItem('tester-name') || 'unknown' }),
      })
    } catch (err) {
      console.error('Failed to save L2 cell value:', err)
    }
  }, [])

  const handleExport = useCallback(async () => {
    if (!data || data.sheets.length === 0) return
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()

    for (const sheet of data.sheets) {
      const sheetCols = data.columns
        .filter(c => c.SheetId === sheet.id)
        .sort((a, b) => a.DisplayOrder - b.DisplayOrder)
      const sheetDevices = data.devices
        .filter(d => d.SheetId === sheet.id)
        .sort((a, b) => a.DeviceName.localeCompare(b.DeviceName))

      const headers = ['Device Name', 'MCM', 'Subsystem', ...sheetCols.map(c => c.Name)]
      const rows = sheetDevices.map(device => {
        const row: (string | null)[] = [device.DeviceName, device.Mcm, device.Subsystem]
        for (const col of sheetCols) {
          const cv = cellValues.get(`${device.id}-${col.id}`)
          if (!cv?.Value || cv.Value === '') {
            row.push('')
          } else if (col.ColumnType === 'check') {
            row.push(cv.Value === 'pass' ? 'Pass' : cv.Value === 'fail' ? 'Fail' : cv.Value)
          } else {
            row.push(cv.Value)
          }
        }
        return row
      })

      const wsData = [headers, ...rows]
      const ws = XLSX.utils.aoa_to_sheet(wsData)
      ws['!cols'] = [
        { wch: 25 }, { wch: 12 }, { wch: 15 },
        ...sheetCols.map(c => ({
          wch: c.ColumnType === 'check' ? 10 : c.ColumnType === 'notes' ? 20 : c.ColumnType === 'data' ? 15 : 15
        }))
      ]
      XLSX.utils.book_append_sheet(wb, ws, (sheet.DisplayName || sheet.Name).slice(0, 31))
    }

    const date = new Date().toISOString().split('T')[0]
    XLSX.writeFile(wb, `L2-Validation-${date}.xlsx`)
  }, [data, cellValues])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading L2 validation data...
      </div>
    )
  }

  if (error) {
    return <div className="flex items-center justify-center h-64 text-destructive">{error}</div>
  }

  if (!data || !data.hasData || data.sheets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
        <ClipboardCheck className="h-10 w-10 opacity-40" />
        <p className="text-sm">No L2 validation data. Pull from cloud to load.</p>
      </div>
    )
  }

  const sheetStats = data.sheets.map(sheet => {
    const sheetDevices = data.devices.filter(d => d.SheetId === sheet.id)
    const sheetCols = data.columns.filter(c => c.SheetId === sheet.id && c.ColumnType === 'check')
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
  const activeStats = sheetStats[activeSheet]

  const guideContent = (
    <>
      {/* Sheet progress */}
      <div className="px-4 py-3 border-b shrink-0">
        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
          <span className="font-medium">{activeSheetData.DisplayName || activeSheetData.Name}</span>
          <span className="tabular-nums">
            {activeStats.completed}/{activeStats.total}
            {activeStats.total > 0 && ` (${Math.round((activeStats.completed / activeStats.total) * 100)}%)`}
          </span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all"
            style={{ width: `${activeStats.total > 0 ? Math.round((activeStats.completed / activeStats.total) * 100) : 0}%` }}
          />
        </div>
        <div className="flex gap-3 mt-2 text-[11px] text-muted-foreground">
          <span>{activeStats.deviceCount} devices</span>
          <span>{activeStats.colCount} checks</span>
        </div>
      </div>

      {/* Column list */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
          Columns ({activeColumns.length})
        </p>
        <div className="space-y-4">
          {activeColumns.map(col => (
            <div key={col.id}>
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn("shrink-0 text-[10px] px-1.5 py-0.5", COL_TYPE_STYLES[col.ColumnType])}
                >
                  {col.ColumnType}
                </Badge>
                <span className="text-sm font-medium text-foreground">{col.Name}</span>
              </div>
              {col.Description ? (
                <p className="text-xs text-muted-foreground mt-1 pl-0.5 leading-relaxed">
                  {col.Description}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground/60 mt-1 pl-0.5 italic">
                  {COL_TYPE_HINTS[col.ColumnType] || "Enter the required value"}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="px-4 py-3 border-t bg-muted/30 shrink-0 text-xs text-muted-foreground leading-relaxed">
        <strong>check</strong> = tap to cycle pass/fail &middot; <strong>data</strong> = type value &middot; <strong>readonly</strong> = pre-filled &middot; <strong>notes</strong> = free text
        <p className="mt-1 italic text-[10px]">Right-click any column header for quick info.</p>
      </div>
    </>
  )

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="text-xs font-medium text-muted-foreground whitespace-nowrap tabular-nums">
          {completedChecks}/{totalChecks} ({overallPercent}%)
        </span>
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${overallPercent}%` }} />
        </div>
        <div className="flex items-center border rounded-md overflow-hidden">
          <button
            className={cn("px-2 py-1 text-xs font-medium transition-colors", viewMode === 'sheets' ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            onClick={() => setViewMode('sheets')}
          >
            <Table2 className="h-3 w-3 inline mr-1" />Sheets
          </button>
          <button
            className={cn("px-2 py-1 text-xs font-medium transition-colors", viewMode === 'overview' ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            onClick={() => setViewMode('overview')}
          >
            <LayoutGrid className="h-3 w-3 inline mr-1" />Overview
          </button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={handleExport}
          disabled={!data || data.sheets.length === 0}
        >
          <Download className="h-3 w-3" />
          Export
        </Button>
        {viewMode === 'sheets' && (
          <Button
            variant={showGuide ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => setShowGuide(!showGuide)}
          >
            <Info className="h-3 w-3" />
            Guide
          </Button>
        )}
      </div>

      {viewMode === 'overview' ? (
        <div className="flex-1 min-h-0">
          <L2OverviewMatrix />
        </div>
      ) : (
      <>
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

      {/* Main content: grid + guide panel */}
      <div className="flex-1 min-h-0 flex relative">
        {/* Grid */}
        <div className="flex-1 min-w-0 min-h-0">
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

        {/* Guide — Desktop: resizable right sidebar */}
        {showGuide && !isNarrow && (
          <div className="shrink-0 border-l bg-background flex flex-col min-h-0 relative" style={{ width: sidebarWidth }}>
            {/* Resize handle on left edge */}
            <div
              className="absolute left-0 top-0 bottom-0 w-[6px] cursor-col-resize z-20 flex items-center justify-center hover:bg-primary/20 active:bg-primary/30 transition-colors"
              onMouseDown={(e) => { e.preventDefault(); setResizingSidebar({ startX: e.clientX, startW: sidebarWidth }) }}
              onTouchStart={(e) => { setResizingSidebar({ startX: e.touches[0].clientX, startW: sidebarWidth }) }}
            >
              <div className="w-[3px] h-8 rounded-full bg-border" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/40 shrink-0">
              <h4 className="text-xs font-semibold">Column Guide</h4>
              <button onClick={() => setShowGuide(false)} className="text-muted-foreground hover:text-foreground p-1">
                <PanelRightClose className="h-4 w-4" />
              </button>
            </div>

            {guideContent}
          </div>
        )}

        {/* Guide — Tablet/narrow: bottom sheet overlay */}
        {showGuide && isNarrow && (
          <>
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/30 z-40"
              onClick={() => setShowGuide(false)}
            />
            {/* Bottom sheet */}
            <div className="absolute bottom-0 left-0 right-0 z-50 bg-background rounded-t-xl shadow-2xl border-t flex flex-col"
              style={{ maxHeight: '70vh' }}
            >
              {/* Drag indicator + header */}
              <div className="flex flex-col items-center pt-2 pb-1 shrink-0">
                <div className="w-10 h-1 rounded-full bg-muted-foreground/30 mb-2" />
                <div className="flex items-center justify-between w-full px-4">
                  <h4 className="text-sm font-semibold">Column Guide</h4>
                  <button onClick={() => setShowGuide(false)} className="text-muted-foreground hover:text-foreground p-1">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {guideContent}
            </div>
          </>
        )}
      </div>
      </>
      )}
    </div>
  )
}
