"use client"

import { useState, useEffect, useCallback, useRef } from 'react'
import { FVSheetGrid, type ExtraColumn } from './fv-sheet-grid'
import { FVOverviewMatrix } from './fv-overview-matrix'
import { Badge } from '@/components/ui/badge'
import { authFetch, getSignalRHubUrl } from '@/lib/api-config'
import { cn } from '@/lib/utils'
import { Loader2, ClipboardCheck, Info, X, PanelRightClose, GripVertical, LayoutGrid, Table2, Download, Filter, Zap, Search, RefreshCw, AlertTriangle, CloudDownload, Wrench } from 'lucide-react'
import { VfdWizardModal } from './vfd-wizard-modal'
import { Button } from '@/components/ui/button'
import { useUser } from '@/lib/user-context'
import { useSignalR, FVCellUpdate } from '@/lib/signalr-client'
import { doesFVColumnCountForProgress, normalizeFVInputType } from '@/lib/fv-utils'
import { saveL2Cell, replayL2Outbox, pendingCount, type OutboxDeps } from '@/lib/l2-outbox'

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
  /**
   * VFD mode — repurposes this same typed FV grid as the VFD Commissioning tab.
   * When on, the view locks to the VFD/APF sheet (no sheet tabs, no overview),
   * appends the read-only Blocked + Addressed handoff columns sourced from
   * /api/vfd-commissioning/state, and adds an "Addressed" quick-filter option.
   * All typed-cell rendering, filters, search, virtualization and the wizard
   * launch are reused unchanged.
   */
  vfdMode?: boolean
}

/** Per-device blocked/addressed annotations from /api/vfd-commissioning/state. */
interface VfdAnnotation {
  blocked: boolean
  blockerParty: string | null
  blockerReason: string | null
  addressed: boolean
  addressedBy: string | null
  addressedAt: string | null
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

// `scope` distinguishes persisted filter state per subsystem AND per mode, so the
// VFD tab (vfdMode) never inherits the FV tab's sheet selection or its
// VFD-only "addressed" quick-filter, and vice-versa.
function fvStorageKey(scope: string): string {
  return scope ? `${FV_STORAGE_KEY}-${scope}` : FV_STORAGE_KEY
}

function loadFVState(scope: string): Partial<FVPersistedState> {
  try {
    const raw = localStorage.getItem(fvStorageKey(scope))
    if (!raw) return {}
    return JSON.parse(raw) as Partial<FVPersistedState>
  } catch { return {} }
}

function saveFVState(state: FVPersistedState, scope: string): void {
  try {
    localStorage.setItem(fvStorageKey(scope), JSON.stringify(state))
  } catch { /* quota exceeded or private mode — ignore */ }
}

export function FVValidationView({ subsystemId, plcConnected = false, vfdMode = false }: FVValidationViewProps) {
  const { currentUser } = useUser()
  const [data, setData] = useState<FVData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // VFD mode: per-device blocked/addressed annotations keyed by deviceName,
  // merged onto the reused FV grid as the Blocked + Addressed columns.
  const [vfdAnnotations, setVfdAnnotations] = useState<Map<string, VfdAnnotation>>(new Map())

  // Persisted-state scope: per-subsystem AND per-mode so VFD and FV tabs keep
  // independent sheet selection + filters.
  const persistScope = `${vfdMode ? 'vfd-' : ''}${subsystemId ?? ''}`

  // Restore persisted state on mount
  const _saved = useRef(loadFVState(persistScope))
  const [activeSheet, setActiveSheet] = useState(_saved.current.activeSheet ?? 0)
  const [showGuide, setShowGuide] = useState(false)
  const [viewMode, setViewMode] = useState<'sheets' | 'overview'>(_saved.current.viewMode ?? 'sheets')
  const [cellValues, setCellValues] = useState<Map<string, { Value: string | null; Version: number }>>(new Map())
  // Cells whose durable save has not yet been confirmed by the server. Shown as
  // an "unsaved" indicator so a failed save is never invisible; cleared once the
  // outbox confirms. Backed by the durable l2-outbox (survives reload).
  const [unsavedCells, setUnsavedCells] = useState<Set<string>>(new Set())
  // Durable-save deps, created ONCE (stable ref) so the mount-replay effect, the
  // beforeunload guard, and handleCellChange all share the same instance and
  // never close over a stale copy. Persists to localStorage, pushes via authFetch.
  const l2SaveDepsRef = useRef<OutboxDeps>({
    storage: typeof window !== 'undefined' ? window.localStorage : ({ getItem: () => null, setItem: () => {} } as any),
    fetchFn: (input, init) => authFetch(input, init) as any,
  })
  const l2SaveDeps = l2SaveDepsRef.current
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

  type QuickFilter = "all" | "complete" | "incomplete" | "has_failures" | "all_passed" | "addressed"
  const [quickFilter, setQuickFilter] = useState<QuickFilter>((_saved.current.quickFilter as QuickFilter) ?? "all")
  const [columnFilters, setColumnFilters] = useState<Record<string, any>>(_saved.current.columnFilters ?? {})
  const [fixedFilters, setFixedFilters] = useState<{ device: string[] | null; mcm: string[] | null; subsystem: string[] | null }>(_saved.current.fixedFilters ?? { device: null, mcm: null, subsystem: null })
  const [searchQuery, setSearchQuery] = useState(_saved.current.searchQuery ?? "")

  // Persist filter state whenever it changes
  useEffect(() => {
    saveFVState({ activeSheet, quickFilter, columnFilters, fixedFilters, searchQuery, viewMode }, persistScope)
  }, [activeSheet, quickFilter, columnFilters, fixedFilters, searchQuery, viewMode, persistScope])

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
      // Scope to THIS MCM on a central server so the FV page shows the selected
      // subsystem's devices (not whichever MCM was pulled last). Omitted on a
      // single-MCM tablet (no subsystemId) → returns all, as before.
      //
      // VFD mode scopes by SHEET, not subsystem: /api/l2?subsystemId=N would
      // filter L2 devices by their owning subsystem, but VFD/APF belts may be
      // keyed to a different subsystem than the route :id (cloud set them to 38
      // while the page is /commissioning/16) — subsystem-scoping would show the
      // APF sheet with ZERO devices. Instead ?vfd=1 returns ONLY the VFD/APF
      // sheet's devices + their cells (all subsystems), which is the exact set
      // this tab renders — a fraction of the payload vs the old unscoped fetch
      // that pulled every sheet's devices + the whole cell-values table (the
      // multi-second empty-grid delay on large projects like CDW5).
      const scope = vfdMode ? 'vfd=1&' : (subsystemId ? `subsystemId=${subsystemId}&` : '')
      const res = await authFetch(`/api/l2?${scope}_t=${Date.now()}`)
      if (!res.ok) throw new Error(`Failed to fetch functional validation data: ${res.status}`)
      const json: FVData = await res.json()
      setData(json)

      const map = new Map<string, { Value: string | null; Version: number }>()
      for (const cv of json.cellValues) {
        map.set(`${cv.DeviceId}-${cv.ColumnId}`, { Value: cv.Value, Version: cv.Version })
      }
      setCellValues(map)
      console.log(`[FV] Refreshed: ${json.cellValues.length} cells loaded`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load functional validation data')
    } finally {
      setLoading(false)
    }
  }, [subsystemId, vfdMode])

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
      // Scope the manual L2 pull to THIS view's route subsystem only. Never
      // fall back to the singleton config.subsystemId: on a central server that
      // is the last-connected MCM, and /api/cloud/pull-l2 does a scoped
      // delete+reinsert — a wrong subId here would wipe another MCM's L2 (the
      // v2.42.1 per-MCM wiring bug class). If the prop is absent the guard
      // below errors cleanly instead of pulling the wrong subsystem.
      const subId = subsystemId

      if (!remoteUrl) throw new Error('No cloud URL configured — go to Settings and set Remote URL')
      if (!subId) throw new Error('No subsystem ID configured for this view')

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

  // VFD mode: load per-device blocked/addressed annotations from the dedicated
  // VFD state endpoint and key them by deviceName for an O(1) merge in the grid.
  const loadVfdAnnotations = useCallback(async () => {
    if (!vfdMode) return
    try {
      const res = await authFetch('/api/vfd-commissioning/state')
      if (!res.ok) return
      const json = await res.json()
      const map = new Map<string, VfdAnnotation>()
      for (const row of (json.states || [])) {
        if (!row.deviceName) continue
        map.set(row.deviceName, {
          blocked: Boolean(row.blocked),
          blockerParty: row.blockerParty ?? null,
          blockerReason: row.blockerReason ?? null,
          addressed: Boolean(row.addressed),
          addressedBy: row.addressedBy ?? null,
          addressedAt: row.addressedAt ?? null,
        })
      }
      setVfdAnnotations(map)
    } catch { /* best-effort; columns simply show "—" */ }
  }, [vfdMode])

  useEffect(() => { fetchData() }, [fetchData])

  // Reload recovery: on mount, replay any FV edits that never confirmed (e.g. the
  // tablet was reloaded / lost connectivity mid-save). Then refresh so the grid
  // reflects the reconciled truth. Also warn before unload while edits are still
  // unconfirmed so work isn't lost by navigating away.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await replayL2Outbox(l2SaveDeps)
        if (!cancelled && res.replayed > 0) await fetchData()
        if (!cancelled) {
          const remaining = pendingCount(l2SaveDeps.storage)
          if (remaining > 0) console.warn(`[FV] ${remaining} FV cell edit(s) still pending after replay`)
        }
      } catch { /* best-effort */ }
    })()
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingCount(l2SaveDeps.storage) > 0) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { cancelled = true; window.removeEventListener('beforeunload', beforeUnload) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // VFD mode: show the LOCALLY-known blocked/addressed badges immediately, and
  // in parallel pull the cloud-authoritative ADDRESSED flag (so a tech sees what
  // a mechanic just marked), re-loading the badges when it lands. Previously the
  // badges waited on the cloud refresh (15s server timeout) — offline, the tab
  // sat badge-less for the full stall (2026-07-08 offline audit).
  useEffect(() => {
    if (!vfdMode) return
    let cancelled = false
    void loadVfdAnnotations() // instant, local-only
    if (subsystemId && subsystemId > 0) {
      ;(async () => {
        try {
          await authFetch('/api/vfd-commissioning/refresh-addressed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subsystemId }),
          })
          if (!cancelled) await loadVfdAnnotations() // pick up fresh cloud marks
        } catch { /* best-effort — local badges already shown */ }
      })()
    }
    return () => { cancelled = true }
  }, [vfdMode, subsystemId, loadVfdAnnotations])

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
    // Optimistically mark unsaved until the durable save confirms.
    setUnsavedCells(prev => new Set(prev).add(key))
    const updatedBy = currentUser?.fullName || localStorage.getItem('tester-name') || 'unknown'
    // saveL2Cell persists the edit to the durable outbox BEFORE the POST, checks
    // res.ok, and retries transient failures. It NEVER silently drops the edit —
    // a reload replays whatever the outbox still holds.
    const result = await saveL2Cell({ deviceId, columnId, value, updatedBy, ts: Date.now() }, l2SaveDeps)
    setUnsavedCells(prev => {
      const next = new Set(prev)
      if (result.ok) next.delete(key)
      return next
    })
    if (!result.ok) {
      console.error('[FV] Cell save not confirmed — kept in outbox for retry:', { deviceId, columnId, ...result })
    }
  }, [currentUser]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // User-facing label: this same component powers both the Functional tab and
  // the VFD Commissioning tab (vfdMode).
  const fvLabel = vfdMode ? 'VFD Commissioning' : 'Functional Validation'
  if (loading) {
    // Grid-shaped skeleton (not an empty pane): a toolbar bar + header row +
    // placeholder rows so the layout is stable and it reads as "loading the
    // grid", matching where the real data lands.
    return (
      <div className="p-3 space-y-3" aria-busy="true" aria-label={`Loading ${fvLabel} data`}>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Loading {fvLabel}…</span>
          <div className="ml-auto h-8 w-40 rounded-md bg-muted animate-pulse" />
        </div>
        <div className="rounded-md border overflow-hidden">
          <div className="h-9 bg-muted/60 animate-pulse border-b" />
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 h-11 border-b last:border-b-0">
              <div className="h-4 w-40 rounded bg-muted animate-pulse" />
              <div className="h-4 w-24 rounded bg-muted/70 animate-pulse" />
              <div className="h-6 w-16 rounded-full bg-muted/70 animate-pulse" />
              <div className="h-4 w-20 rounded bg-muted/60 animate-pulse ml-auto" />
            </div>
          ))}
        </div>
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
          <p className="text-sm font-medium">No {fvLabel} data available</p>
          <p className="text-xs">Pull from cloud to load {vfdMode ? 'the VFD/APF sheet' : 'FV sheets'}, or retry if you just pulled.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchData} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Retry Loading
          </Button>
          <Button variant="outline" size="sm" onClick={handleManualL2Pull} disabled={l2Pulling} className="gap-2">
            <CloudDownload className="h-4 w-4" />
            {l2Pulling ? `Pulling ${fvLabel}...` : `Pull ${fvLabel} from Cloud`}
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

  // VFD mode locks the view to a single VFD/APF sheet regardless of the
  // persisted activeSheet (there are no sheet tabs to switch in this mode).
  // Prefer one that actually has local device rows: a project can define BOTH
  // a 'VFD' and an 'APF' sheet with all belts on one of them (CDW5 keeps 222
  // devices on APF while the VFD sheet pulled zero rows) — locking to the
  // first empty sheet rendered a permanently blank grid with no way out.
  const vfdSheetIndex = vfdMode
    ? (() => {
        const withDevices = data.sheets.findIndex(s => vfdSheetIds.has(s.id) && data.devices.some(d => d.SheetId === s.id))
        return withDevices >= 0 ? withDevices : data.sheets.findIndex(s => vfdSheetIds.has(s.id))
      })()
    : -1

  // Clamp at render time. The persisted `activeSheet` index can outlive its
  // data — e.g. switching subsystems shrinks `data.sheets` and the useEffect
  // clamp below only catches up on the *next* render. Without this guard,
  // `data.sheets[activeSheet]` returns undefined and the `.id` deref below
  // throws before the effect ever fires.
  // On the Functional page (non-VFD mode) the VFD/APF sheet is intentionally
  // hidden — it lives on the dedicated VFD tab — so the active sheet must be a
  // NON-VFD sheet. Redirect off a VFD/APF sheet (or a stale/out-of-range index)
  // to the first functional sheet.
  const firstFvSheetIndex = data.sheets.findIndex(s => !vfdSheetIds.has(s.id))
  const safeActiveSheet = vfdMode
    ? (vfdSheetIndex >= 0 ? vfdSheetIndex : 0)
    : (activeSheet >= 0 && activeSheet < data.sheets.length && !vfdSheetIds.has(data.sheets[activeSheet]?.id)
        ? activeSheet
        : (firstFvSheetIndex >= 0 ? firstFvSheetIndex : 0))
  // VFD mode but no VFD/APF sheet exists in the pulled L2 data.
  if (vfdMode && vfdSheetIndex < 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
        <Zap className="h-10 w-10 opacity-40" />
        <p className="text-sm font-medium">No VFD/APF sheet in the pulled Functional Validation data</p>
        <p className="text-xs">Pull from cloud to load the VFD/APF sheet.</p>
      </div>
    )
  }

  const activeSheetData = data.sheets[safeActiveSheet]
  if (!activeSheetData) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No L2 sheets configured for this subsystem.
      </div>
    )
  }
  // VFD Commissioning column order: match the wizard step sequence, then push
  // Notes/comment + any blocker/responsible-party/description columns to the
  // very end. Name-based, so a column not present on the sheet (e.g. the
  // synthetic "Run Verified" before it's provisioned) is simply skipped. The
  // plain Functional Validation tab keeps the cloud DisplayOrder unchanged.
  const VFD_COL_RANK: Record<string, number> = {
    'verify identity': 0, 'motor hp (field)': 1, 'vfd hp (field)': 2,
    'run verified': 3, 'belt tracked': 4, 'check direction': 5,
    'polarity': 6, 'speed set up': 7,
  }
  const vfdColRank = (name: string): number => {
    const n = (name || '').trim().toLowerCase()
    if (n in VFD_COL_RANK) return VFD_COL_RANK[n]
    if (/note|comment|blocker|responsible|party|description/.test(n)) return 900
    return 500
  }
  const activeColumns = (() => {
    const cols = data.columns
      .filter(c => c.SheetId === activeSheetData.id)
      .sort((a, b) => a.DisplayOrder - b.DisplayOrder)
    if (!vfdMode) return cols
    return [...cols].sort((a, b) => vfdColRank(a.Name) - vfdColRank(b.Name) || a.DisplayOrder - b.DisplayOrder)
  })()
  const activeDevices = data.devices
    .filter(d => d.SheetId === activeSheetData.id)
    .sort((a, b) => a.DeviceName.localeCompare(b.DeviceName))
  const activeStats = sheetStats[safeActiveSheet]

  // VFD row tone: a device with an open blocker paints the whole row RED; a
  // device whose wizard-check columns are ALL filled paints it GREEN; partial
  // stays default (the values are visible in the columns). Blocked wins.
  const vfdCheckColIds = vfdMode
    ? activeColumns.filter(c => ((c.Name || '').trim().toLowerCase()) in VFD_COL_RANK).map(c => c.id)
    : []
  const rowTone = vfdMode
    ? (device: { id: number; DeviceName: string }): 'blocked' | 'complete' | null => {
        if (vfdAnnotations.get(device.DeviceName)?.blocked) return 'blocked'
        if (
          vfdCheckColIds.length > 0 &&
          vfdCheckColIds.every(cid => {
            const v = cellValues.get(`${device.id}-${cid}`)?.Value
            return v != null && String(v).trim() !== ''
          })
        ) return 'complete'
        return null
      }
    : undefined

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
    // VFD mode hides the Subsystem column/filter entirely (MCM is the axis), so
    // never apply a subsystem filter there — otherwise a value persisted before
    // this change would silently filter rows with no visible control to clear it.
    if (!vfdMode && fixedFilters.subsystem !== null && fixedFilters.subsystem.length > 0 && !fixedFilters.subsystem.includes(device.Subsystem || "")) return false

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
      } else if (quickFilter === "addressed") {
        // VFD handoff: belts a mechanic marked addressed on the cloud (ready to re-run).
        if (!vfdAnnotations.get(device.DeviceName)?.addressed) return false
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

  // VFD mode: read-only Blocked + Addressed handoff columns appended to the
  // reused FV typed grid. Sourced from /api/vfd-commissioning/state (parsed
  // Bump Blocker cell + cloud ADDRESSED mirror), merged by deviceName.
  const vfdExtraColumns: ExtraColumn[] = vfdMode ? [
    {
      key: 'vfd-blocked',
      label: 'Blocked',
      width: 240,
      render: (device) => {
        const a = vfdAnnotations.get(device.DeviceName)
        if (!a?.blocked) return <span className="text-muted-foreground/50">—</span>
        return (
          <span
            className="inline-flex items-center gap-1 max-w-full text-[11px] text-amber-700 dark:text-amber-300"
            title={`${a.blockerParty ? a.blockerParty + ': ' : ''}${a.blockerReason ?? 'Blocked'}`}
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {a.blockerParty ? <span className="font-semibold">{a.blockerParty}: </span> : null}
              {a.blockerReason || 'Blocked'}
            </span>
          </span>
        )
      },
    },
    {
      key: 'vfd-addressed',
      label: 'Addressed',
      width: 180,
      render: (device) => {
        const a = vfdAnnotations.get(device.DeviceName)
        if (!a?.blocked || !a.addressed) return <span className="text-muted-foreground/50">—</span>
        const stamp = (() => {
          const parts: string[] = []
          if (a.addressedAt) {
            const d = new Date(a.addressedAt)
            if (!isNaN(d.getTime())) parts.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
          }
          if (a.addressedBy) parts.push(a.addressedBy)
          return parts.join(' · ')
        })()
        return (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-sky-100 text-sky-800 border border-sky-200 dark:bg-sky-900/40 dark:text-sky-200 dark:border-sky-800 max-w-full"
            title={`Mechanic marked addressed${a.addressedBy ? ` by ${a.addressedBy}` : ''}${a.addressedAt ? ` on ${new Date(a.addressedAt).toLocaleString()}` : ''} — re-run the wizard`}
          >
            <Wrench className="h-3 w-3 shrink-0" />
            <span className="truncate">Addressed{stamp ? ` · ${stamp}` : ''}</span>
          </span>
        )
      },
    },
  ] : []

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
      {unsavedCells.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-100 dark:bg-amber-950 text-amber-900 dark:text-amber-200 text-xs shrink-0 border-b border-amber-300 dark:border-amber-800">
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
          <span>{unsavedCells.size} cell{unsavedCells.size === 1 ? '' : 's'} not yet saved — retrying automatically. Don&apos;t close this tab until saved.</span>
        </div>
      )}
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0">
        <span className="text-sm font-medium text-muted-foreground whitespace-nowrap tabular-nums">
          {completedChecks}/{totalChecks} ({overallPercent}%)
        </span>
        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${overallPercent}%` }} />
        </div>
        {!vfdMode && (
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
        )}
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

      {(viewMode === 'overview' && !vfdMode) ? (
        <div className="flex-1 min-h-0">
          <FVOverviewMatrix />
        </div>
      ) : (
      <>
      {/* Sheet tabs — hidden in VFD mode (locked to the VFD/APF sheet) */}
      {!vfdMode && (
      <div className="flex gap-1 overflow-x-auto px-3 py-1.5 border-b shrink-0 bg-muted/30">
        {data.sheets.map((sheet, idx) => {
          // The VFD/APF sheet is owned by the dedicated VFD tab — never list it
          // as a Functional Validation sheet tab.
          if (vfdSheetIds.has(sheet.id)) return null
          const stats = sheetStats[idx]
          const isActive = idx === safeActiveSheet
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
      )}

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
        {vfdMode && (
          <button
            onClick={() => setQuickFilter(quickFilter === "addressed" ? "all" : "addressed")}
            className={cn(
              "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors flex items-center gap-1",
              quickFilter === "addressed"
                ? "border-sky-500 bg-sky-500 text-white"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
            )}
            title="Show only belts a mechanic addressed on the cloud (ready to re-run)"
          >
            <Wrench className="h-3 w-3" />
            Addressed
          </button>
        )}
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
          {/* Filters hiding EVERY row renders a blank grid with no hint — the
              toolbar's 11px "Clear filters" link is far too subtle when the
              whole table is empty (filters persist in localStorage, so this
              state survives reloads and reads as "no data"). Make it loud. */}
          {filteredDevices.length === 0 && activeDevices.length > 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-48 gap-3 border border-dashed border-amber-400 dark:border-amber-600 rounded-lg m-2 bg-amber-50/60 dark:bg-amber-950/20">
              <Filter className="h-8 w-8 text-amber-600 dark:text-amber-400" />
              <div className="text-center space-y-1">
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  All {activeDevices.length} devices are hidden by active filters
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  A search, quick filter or column filter (saved from a previous visit) is excluding every row.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => { setQuickFilter("all"); setColumnFilters({}); setFixedFilters({ device: null, mcm: null, subsystem: null }); setSearchQuery("") }}
                className="gap-2 bg-amber-600 hover:bg-amber-700 text-white border-0"
              >
                <X className="h-4 w-4" />
                Clear all filters
              </Button>
            </div>
          ) : (
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
            extraColumns={vfdExtraColumns}
            rowTone={rowTone}
            emptyMessage={activeDevices.length === 0 ? "No devices in this sheet" : "No devices match the current filters"}
          />
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
            // VFD mode: a Bump Test failure may have set/cleared the blocker.
            loadVfdAnnotations()
          }}
        />
      )}
    </div>
  )
}
