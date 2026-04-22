"use client"

import { useState, useEffect, useCallback, useRef } from 'react'
import { FVSheetGrid } from './fv-sheet-grid'
import { FVOverviewMatrix } from './fv-overview-matrix'
import { Badge } from '@/components/ui/badge'
import { authFetch, getSignalRHubUrl } from '@/lib/api-config'
import { cn } from '@/lib/utils'
import { Loader2, ClipboardCheck, Info, X, PanelRightClose, GripVertical, LayoutGrid, Table2, Download, Filter, Zap, Search, RefreshCw, AlertTriangle, CloudDownload } from 'lucide-react'
import { VfdWizardModal } from './vfd-wizard-modal'
import { Button } from '@/components/ui/button'
import { useUser } from '@/lib/user-context'
import { useSignalR, FVCellUpdate } from '@/lib/signalr-client'
import { doesFVColumnCountForProgress, normalizeFVInputType } from '@/lib/fv-utils'

interface FVSheet {
  id: number
  Name: string
  DisplayName: string
}

interface FVColumn {
  id: number
  SheetId: number
  Name: string
  ColumnType: string
  InputType?: string | null
  DisplayOrder: number
  IncludeInProgress?: number
  Description?: string | null
}

interface FVDevice {
  id: number
  SheetId: number
  DeviceName: string
  Mcm: string
  Subsystem: string
  CompletedChecks: number
  TotalChecks: number
}

interface FVCellValue {
  DeviceId: number
  ColumnId: number
  Value: string | null
  Version: number
}

interface FVData {
  sheets: FVSheet[]
  columns: FVColumn[]
  devices: FVDevice[]
  cellValues: FVCellValue[]
  hasData: boolean
}

interface FVValidationViewProps {
  subsystemId?: number
  plcConnected?: boolean
}

const COL_TYPE_STYLES: Record<string, string> = {
  pass_fail: "bg-green-100 text-green-700 border-green-300 dark:bg-green-900 dark:text-green-300",
  number: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900 dark:text-blue-300",
  readonly: "bg-gray-100 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-400",
  text: "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900 dark:text-amber-300",
}

const COL_TYPE_HINTS: Record<string, string> = {
  pass_fail: "Tap to cycle: pass / fail / empty",
  number: "Type a measured or observed value",
  readonly: "Pre-filled (cannot edit)",
  text: "Free-text notes or comments",
}

const MIN_SIDEBAR_W = 240
const MAX_SIDEBAR_W = 600
const DEFAULT_SIDEBAR_W = 320

// ── Persistent FV filter state ──────────────────────────────────────
// Persists the user's sheet selection and filters to localStorage so they
// survive tab switches, navigation, and page reloads.

const FV_STORAGE_KEY = 'fv-view-state'

interface FVPersistedState {
  activeSheet: number
  quickFilter: string
  columnFilters: Record<string, any>
  fixedFilters: { device: string[] | null; mcm: string[] | null; subsystem: string[] | null }
  searchQuery: string
  viewMode: 'sheets' | 'overview'
}

function loadFVState(subsystemId?: number): Partial<FVPersistedState> {
  try {
    const key = subsystemId ? `${FV_STORAGE_KEY}-${subsystemId}` : FV_STORAGE_KEY
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    return JSON.parse(raw) as Partial<FVPersistedState>
  } catch { return {} }
}

function saveFVState(state: FVPersistedState, subsystemId?: number): void {
  try {
    const key = subsystemId ? `${FV_STORAGE_KEY}-${subsystemId}` : FV_STORAGE_KEY
    localStorage.setItem(key, JSON.stringify(state))
  } catch { /* quota exceeded or private mode — ignore */ }
}

export function FVValidationView({ subsystemId, plcConnected = false }: FVValidationViewProps) {
  const { currentUser } = useUser()
  const [data, setData] = useState<FVData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Restore persisted state on mount
  const _saved = useRef(loadFVState(subsystemId))
  const [activeSheet, setActiveSheet] = useState(_saved.current.activeSheet ?? 0)
  const [showGuide, setShowGuide] = useState(false)
  const [viewMode, setViewMode] = useState<'sheets' | 'overview'>(_saved.current.viewMode ?? 'sheets')
  const [cellValues, setCellValues] = useState<Map<string, { Value: string | null; Version: number }>>(new Map())
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_W)
  const [resizingSidebar, setResizingSidebar] = useState<{ startX: number; startW: number } | null>(null)
  const [isNarrow, setIsNarrow] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Manual L2/FV pull state
  const [l2Pulling, setL2Pulling] = useState(false)
  const [l2PullError, setL2PullError] = useState<string | null>(null)
  const [l2PullResult, setL2PullResult] = useState<string | null>(null)

  // VFD wizard state — opened from either the VFD tab or the sheet grid
  const [wizardDevice, setWizardDevice] = useState<{ id: number; deviceName: string; mcm: string; subsystem: string; sheetName?: string } | null>(null)

  type QuickFilter = "all" | "complete" | "incomplete" | "has_failures" | "all_passed"
  const [quickFilter, setQuickFilter] = useState<QuickFilter>((_saved.current.quickFilter as QuickFilter) ?? "all")
  const [columnFilters, setColumnFilters] = useState<Record<string, any>>(_saved.current.columnFilters ?? {})
  const [fixedFilters, setFixedFilters] = useState<{ device: string[] | null; mcm: string[] | null; subsystem: string[] | null }>(_saved.current.fixedFilters ?? { device: null, mcm: null, subsystem: null })
  const [searchQuery, setSearchQuery] = useState(_saved.current.searchQuery ?? "")

  // Persist filter state whenever it changes
  useEffect(() => {
    saveFVState({ activeSheet, quickFilter, columnFilters, fixedFilters, searchQuery, viewMode }, subsystemId)
  }, [activeSheet, quickFilter, columnFilters, fixedFilters, searchQuery, viewMode, subsystemId])

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
      if (!res.ok) throw new Error(`Failed to fetch functional validation data: ${res.status}`)
      const json: FVData = await res.json()
      setData(json)

      const map = new Map<string, { Value: string | null; Version: number }>()
      for (const cv of json.cellValues) {
        map.set(`${cv.DeviceId}-${cv.ColumnId}`, { Value: cv.Value, Version: cv.Version })
      }
      setCellValues(map)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load functional validation data')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleManualL2Pull = useCallback(async () => {
    setL2Pulling(true)
    setL2PullError(null)
    setL2PullResult(null)
    try {
      // Get current config (remoteUrl, apiPassword, subsystemId)
      const configRes = await authFetch('/api/configuration')
      if (!configRes.ok) throw new Error('Could not load config — set cloud URL and API password first')
      const config = await configRes.json()
      const remoteUrl = config.remoteUrl || config.cloudUrl
      const apiPassword = config.apiPassword
      const subId = subsystemId || config.subsystemId

      if (!remoteUrl) throw new Error('No cloud URL configured — go to Settings and set Remote URL')
      if (!subId) throw new Error('No subsystem ID configured')

      console.log(`[FV Pull] Pulling L2 from ${remoteUrl}/api/sync/l2/${subId}`)

      const res = await authFetch('/api/cloud/pull-l2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteUrl, apiPassword, subsystemId: subId }),
      })
      const result = await res.json()

      if (!res.ok || !result.success) {
        const msg = result.error || `Pull failed (${res.status})`
        console.error('[FV Pull] Failed:', msg)
        setL2PullError(msg)
        return
      }

      console.log(`[FV Pull] OK: ${result.l2Pulled} devices, ${result.l2CellsPulled} cells`)
      setL2PullResult(`Pulled ${result.l2Pulled} devices, ${result.l2CellsPulled} cell values`)
      // Reload the FV data
      await fetchData()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[FV Pull] Exception:', msg)
      setL2PullError(msg)
    } finally {
      setL2Pulling(false)
    }
  }, [subsystemId, fetchData])

  useEffect(() => { fetchData() }, [fetchData])

  // Re-fetch FV data when switching back to sheets view (e.g. after using the
  // VFD wizard which writes cells directly via write-l2-cells endpoint).
  const prevViewModeRef = useRef(viewMode)
  useEffect(() => {
    const prev = prevViewModeRef.current
    prevViewModeRef.current = viewMode
    // Refresh when returning to sheets from any other tab
    if (viewMode === 'sheets' && prev !== 'sheets') {
      fetchData()
    }
  }, [viewMode, fetchData])

  // Subscribe to live FV cell updates pushed from the cloud via WebSocket.
  // The local SSE client writes incoming changes to SQLite and broadcasts
  // a cell-updated message; we merge it into local state so testers see
  // remote edits without refreshing.
  const signalR = useSignalR(getSignalRHubUrl())
  useEffect(() => {
    const handleFVUpdate = (update: FVCellUpdate) => {
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
    signalR.onFVCellUpdate(handleFVUpdate)
    return () => {
      signalR.offFVCellUpdate(handleFVUpdate)
    }
  }, [signalR.onFVCellUpdate, signalR.offFVCellUpdate])

  // Clamp persisted activeSheet to valid range once data arrives
  useEffect(() => {
    if (data?.sheets && data.sheets.length > 0 && activeSheet >= data.sheets.length) {
      setActiveSheet(0)
    }
  }, [data?.sheets?.length]) // eslint-disable-line react-hooks/exhaustive-deps

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
      console.error('Failed to save functional validation cell value:', err)
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
          } else if (normalizeFVInputType(col.ColumnType, col.InputType) === 'pass_fail') {
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
          wch: normalizeFVInputType(c.ColumnType, c.InputType) === 'pass_fail'
            ? 10
            : normalizeFVInputType(c.ColumnType, c.InputType) === 'text'
              ? 20
              : 15
        }))
      ]
      XLSX.utils.book_append_sheet(wb, ws, (sheet.DisplayName || sheet.Name).slice(0, 31))
    }

    const date = new Date().toISOString().split('T')[0]
    XLSX.writeFile(wb, `Functional-Validation-${date}.xlsx`)
  }, [data, cellValues])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading functional validation data...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <p className="text-sm text-destructive font-medium">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchData} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  if (!data || !data.hasData || data.sheets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-4">
        <ClipboardCheck className="h-10 w-10 opacity-40" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No functional validation data available</p>
          <p className="text-xs">Pull from cloud to load FV sheets, or retry if you just pulled.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchData} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Retry Loading
          </Button>
          <Button variant="outline" size="sm" onClick={handleManualL2Pull} disabled={l2Pulling} className="gap-2">
            <CloudDownload className="h-4 w-4" />
            {l2Pulling ? 'Pulling Functional Validation...' : 'Pull Functional Validation from Cloud'}
          </Button>
        </div>
        {l2PullError && (
          <div className="max-w-md px-4 py-2 rounded-md bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-200 text-xs">
            <p className="font-medium">Functional Validation Pull Error:</p>
            <p className="mt-0.5">{l2PullError}</p>
          </div>
        )}
        {l2PullResult && (
          <div className="max-w-md px-4 py-2 rounded-md bg-green-100 dark:bg-green-950 text-green-800 dark:text-green-200 text-xs">
            <p>{l2PullResult}</p>
          </div>
        )}
      </div>
    )
  }

  const sheetStats = data.sheets.map(sheet => {
    const sheetDevices = data.devices.filter(d => d.SheetId === sheet.id)
    const sheetCols = data.columns.filter(c => c.SheetId === sheet.id && doesFVColumnCountForProgress(c))
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

  // VFD devices: devices on sheets named "VFD" or "APF" (case-insensitive), OR devices whose name contains "VFD"
  const vfdSheetIds = new Set(data.sheets.filter(s =>
    s.Name.toUpperCase().includes('VFD') || s.Name.toUpperCase().includes('APF')
  ).map(s => s.id))
  const sheetNameById = new Map(data.sheets.map(s => [s.id, s.Name]))
  const vfdDevices = data.devices
    .filter(d => vfdSheetIds.has(d.SheetId) || d.DeviceName.toUpperCase().includes('VFD'))
    .map(d => ({
      id: d.id,
      deviceName: d.DeviceName,
      mcm: d.Mcm || '',
      subsystem: d.Subsystem || '',
      sheetName: sheetNameById.get(d.SheetId) || '',
    }))

  const activeSheetData = data.sheets[activeSheet]
  const activeColumns = data.columns
    .filter(c => c.SheetId === activeSheetData.id)
    .sort((a, b) => a.DisplayOrder - b.DisplayOrder)
  const activeDevices = data.devices
    .filter(d => d.SheetId === activeSheetData.id)
    .sort((a, b) => a.DeviceName.localeCompare(b.DeviceName))
  const activeStats = sheetStats[activeSheet]

  // Is the currently selected sheet a VFD/APF sheet?
  const isActiveSheetVfd = vfdSheetIds.has(activeSheetData.id)

  const filteredDevices = activeDevices.filter((device) => {
    // Search query
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const matches = device.DeviceName.toLowerCase().includes(q)
        || (device.Mcm || "").toLowerCase().includes(q)
        || (device.Subsystem || "").toLowerCase().includes(q)
      if (!matches) return false
    }

    // Fixed column filters
    if (fixedFilters.device !== null && fixedFilters.device.length > 0 && !fixedFilters.device.includes(device.DeviceName)) return false
    if (fixedFilters.mcm !== null && fixedFilters.mcm.length > 0 && !fixedFilters.mcm.includes(device.Mcm || "")) return false
    if (fixedFilters.subsystem !== null && fixedFilters.subsystem.length > 0 && !fixedFilters.subsystem.includes(device.Subsystem || "")) return false

    // Per-column filters
    for (const [key, filter] of Object.entries(columnFilters)) {
      const colId = parseInt(key)
      const col = activeColumns.find((c) => c.id === colId)
      if (!col) continue
      const cv = cellValues.get(`${device.id}-${colId}`)
      const value = cv?.Value ?? null
      const inputType = normalizeFVInputType(col.ColumnType, col.InputType)

      if (inputType === "pass_fail" && typeof filter === "object") {
        if (value === "pass" && !filter.pass) return false
        if (value === "fail" && !filter.fail) return false
        if (!value && !filter.empty) return false
      } else if (Array.isArray(filter) && filter.length > 0) {
        const cellStr = (value || "").toLowerCase()
        if (!filter.some((tag: string) => cellStr.includes(tag.toLowerCase()))) return false
      }
    }

    // Quick filter
    if (quickFilter !== "all") {
      const progressCols = activeColumns.filter((c) => doesFVColumnCountForProgress(c))
      const pfCols = activeColumns.filter((c) => normalizeFVInputType(c.ColumnType, c.InputType) === "pass_fail")

      if (quickFilter === "complete") {
        const allFilled = progressCols.every((c) => {
          const v = cellValues.get(`${device.id}-${c.id}`)
          return v?.Value != null && v.Value !== ""
        })
        if (!allFilled) return false
      } else if (quickFilter === "incomplete") {
        const hasEmpty = progressCols.some((c) => {
          const v = cellValues.get(`${device.id}-${c.id}`)
          return v?.Value == null || v.Value === ""
        })
        if (!hasEmpty) return false
      } else if (quickFilter === "has_failures") {
        const hasFail = pfCols.some((c) => cellValues.get(`${device.id}-${c.id}`)?.Value === "fail")
        if (!hasFail) return false
      } else if (quickFilter === "all_passed") {
        const allPassed = pfCols.length > 0 && pfCols.every((c) => cellValues.get(`${device.id}-${c.id}`)?.Value === "pass")
        if (!allPassed) return false
      }
    }

    return true
  })

  const hasActiveFilters = quickFilter !== "all" || Object.keys(columnFilters).length > 0 || fixedFilters.device !== null || fixedFilters.mcm !== null || fixedFilters.subsystem !== null || searchQuery !== ""

  /** Open the VFD wizard from the sheet grid */
  const handleOpenWizardFromGrid = (device: { id: number; DeviceName: string; Mcm: string; Subsystem: string }) => {
    setWizardDevice({
      id: device.id,
      deviceName: device.DeviceName,
      mcm: device.Mcm || '',
      subsystem: device.Subsystem || '',
      sheetName: sheetNameById.get(activeSheetData.id) || '',
    })
  }

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
          <span>{activeStats.colCount} progress columns</span>
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
                  className={cn("shrink-0 text-[10px] px-1.5 py-0.5", COL_TYPE_STYLES[normalizeFVInputType(col.ColumnType, col.InputType)])}
                >
                  {normalizeFVInputType(col.ColumnType, col.InputType)}
                </Badge>
                <span className="text-sm font-medium text-foreground">{col.Name}</span>
              </div>
              {col.Description ? (
                <p className="text-xs text-muted-foreground mt-1 pl-0.5 leading-relaxed">
                  {col.Description}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground/60 mt-1 pl-0.5 italic">
                  {COL_TYPE_HINTS[normalizeFVInputType(col.ColumnType, col.InputType)] || "Enter the required value"}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="px-4 py-3 border-t bg-muted/30 shrink-0 text-xs text-muted-foreground leading-relaxed">
        <strong>pass_fail</strong> = pass/fail toggle &middot; <strong>number</strong> = numeric input &middot; <strong>readonly</strong> = imported workbook value &middot; <strong>text</strong> = free text
        <p className="mt-1 italic text-[10px]">Right-click any column header for quick info.</p>
      </div>
    </>
  )

  return (
    <div ref={containerRef} className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0">
        <span className="text-sm font-medium text-muted-foreground whitespace-nowrap tabular-nums">
          {completedChecks}/{totalChecks} ({overallPercent}%)
        </span>
        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${overallPercent}%` }} />
        </div>
        <div className="flex items-center border rounded-md overflow-hidden h-9">
          <button
            className={cn("px-3 h-full text-sm font-medium transition-colors flex items-center", viewMode === 'sheets' ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            onClick={() => setViewMode('sheets')}
          >
            <Table2 className="h-3.5 w-3.5 inline mr-1.5" />Sheets
          </button>
          <button
            className={cn("px-3 h-full text-sm font-medium transition-colors flex items-center", viewMode === 'overview' ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            onClick={() => setViewMode('overview')}
          >
            <LayoutGrid className="h-3.5 w-3.5 inline mr-1.5" />Overview
          </button>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 text-sm gap-1.5"
          onClick={handleExport}
          disabled={!data || data.sheets.length === 0}
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
        <Button
          variant={showGuide ? "default" : "outline"}
          size="sm"
          className="h-9 text-sm gap-1.5"
          onClick={() => setShowGuide(!showGuide)}
          disabled={viewMode === 'overview'}
          title={viewMode === 'overview' ? "Guide is available on the Sheets view" : undefined}
        >
          <Info className="h-3.5 w-3.5" />
          Guide
        </Button>
      </div>

      {viewMode === 'overview' ? (
        <div className="flex-1 min-h-0">
          <FVOverviewMatrix />
        </div>
      ) : (
      <>
      {/* Sheet tabs */}
      <div className="flex gap-1 overflow-x-auto px-3 py-1.5 border-b shrink-0 bg-muted/30">
        {data.sheets.map((sheet, idx) => {
          const stats = sheetStats[idx]
          const isActive = idx === activeSheet
          const isVfd = vfdSheetIds.has(sheet.id)
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
              {isVfd && <Zap className="h-3 w-3" />}
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

      {/* Search + quick filters */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b shrink-0">
        <div className="relative mr-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search devices..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-7 w-44 rounded-md border bg-background pl-7 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {(["all", "complete", "incomplete", "has_failures", "all_passed"] as const).map((qf) => {
          const labels = { all: "All", complete: "Complete", incomplete: "Incomplete", has_failures: "Has Failures", all_passed: "All Passed" }
          return (
            <button
              key={qf}
              onClick={() => setQuickFilter(quickFilter === qf ? "all" : qf)}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                quickFilter === qf
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              {labels[qf]}
            </button>
          )
        })}
        {hasActiveFilters && (
          <button
            onClick={() => { setQuickFilter("all"); setColumnFilters({}); setFixedFilters({ device: null, mcm: null, subsystem: null }); setSearchQuery("") }}
            className="ml-1 text-[11px] text-muted-foreground underline hover:text-foreground"
          >
            Clear filters
          </button>
        )}
        {filteredDevices.length !== activeDevices.length && (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {filteredDevices.length} of {activeDevices.length} devices
          </span>
        )}
      </div>

      {/* Main content: grid + guide panel */}
      <div className="flex-1 min-h-0 flex relative">
        {/* Grid */}
        <div className="flex-1 min-w-0 min-h-0">
          <FVSheetGrid
            sheet={activeSheetData}
            columns={activeColumns}
            devices={filteredDevices}
            allDevices={activeDevices}
            cellValues={cellValues}
            onCellChange={handleCellChange}
            columnFilters={columnFilters}
            fixedFilters={fixedFilters}
            onColumnFilterChange={(colId, value) => {
              setColumnFilters((prev) => {
                if (value === undefined || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && !Array.isArray(value) && value.pass && value.fail && value.empty)) {
                  const next = { ...prev }; delete next[colId]; return next
                }
                return { ...prev, [colId]: value }
              })
            }}
            onFixedFilterChange={(field, value) => setFixedFilters((p) => ({ ...p, [field]: value }))}
            isVfdSheet={isActiveSheetVfd}
            onOpenWizard={isActiveSheetVfd ? handleOpenWizardFromGrid : undefined}
            emptyMessage={activeDevices.length === 0 ? "No devices in this sheet" : "No devices match the current filters"}
          />
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

      {/* VFD Wizard Modal — opened from sheet grid or VFD tab */}
      {wizardDevice && (
        <VfdWizardModal
          device={wizardDevice}
          subsystemId={subsystemId || 0}
          plcConnected={plcConnected}
          sheetName={wizardDevice.sheetName}
          onClose={() => {
            setWizardDevice(null)
            // Wizard may have written cells — refresh the grid.
            fetchData()
          }}
        />
      )}
    </div>
  )
}
