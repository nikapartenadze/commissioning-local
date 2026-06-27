"use client"

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  Zap, Search, X, Wifi, WifiOff, ArrowRight, CheckCircle2, Circle, CircleDot,
  Trash2, Loader2, AlertTriangle, Wrench,
} from 'lucide-react'
import { VfdWizardModal } from './vfd-wizard-modal'

// ── Types ──────────────────────────────────────────────────────────

interface VfdDevice { id: number; deviceName: string; mcm: string; subsystem: string; sheetName?: string }

interface VfdCommissioningViewProps {
  /**
   * Optional explicit device list. When omitted/empty the view self-loads its
   * devices from /api/vfd-commissioning/state (which carries device meta), so
   * the commissioning workspace can mount this tab without pre-loading VFDs.
   */
  devices?: VfdDevice[]
  /** Route subsystem id; used by the wizard for PLC writes + the ADDRESSED pull. */
  subsystemId?: number
  plcConnected: boolean
}

/**
 * Commissioning state for one VFD derived ENTIRELY from the L2 spreadsheet.
 * There is no separate VfdCheckState table anymore — the L2 spreadsheet
 * (stored in local SQLite AND synced to cloud) is the single source of truth.
 *
 * A cell holds a string value when that wizard step has completed. Values are:
 *   - verifyIdentity               → INITIALS DATE stamp from Step 1
 *   - motorHpField / vfdHpField    → numeric text from Step 2 (e.g. "5.0")
 *   - checkDirection / beltTracked → INITIALS DATE stamp (e.g. "ASH 9/5")
 *   - speedSetUp                   → enriched stamp from Step 5
 *                                     e.g. "ASH 9/5 · 200 FPM @ 25.30 RVS"
 *   - bumpBlocker                  → "<stamp> · <party> · <description>" when a
 *                                     Bump Test (Step 3) failure was recorded.
 */
interface CellState {
  verifyIdentity:   string | null
  motorHpField:     string | null
  vfdHpField:       string | null
  checkDirection:   string | null
  polarity:         string | null
  beltTracked:      string | null
  speedSetUp:       string | null
  controlsVerified: string | null
  bumpBlocker:      string | null
}

// Per-device row state: the L2 cells plus the BLOCKED + (read-only, cloud-set)
// ADDRESSED annotations the /state route now returns.
interface RowState {
  cells: CellState
  blocked: boolean
  blockerParty: string | null
  blockerReason: string | null
  addressed: boolean
  addressedBy: string | null
  addressedAt: string | null
}

// ── Helpers ────────────────────────────────────────────────────────

const emptyCells = (): CellState => ({
  verifyIdentity: null, motorHpField: null, vfdHpField: null,
  checkDirection: null, polarity: null, beltTracked: null, speedSetUp: null,
  controlsVerified: null, bumpBlocker: null,
})

const emptyRow = (): RowState => ({
  cells: emptyCells(),
  blocked: false, blockerParty: null, blockerReason: null,
  addressed: false, addressedBy: null, addressedAt: null,
})

function isNonEmpty(v: string | null): boolean {
  return v != null && v.trim() !== ''
}

/** All six commissioning L2 cells populated = done. */
function isDone(s: CellState): boolean {
  return isNonEmpty(s.verifyIdentity)
    && isNonEmpty(s.motorHpField)
    && isNonEmpty(s.vfdHpField)
    && isNonEmpty(s.checkDirection)
    && isNonEmpty(s.beltTracked)
    && isNonEmpty(s.speedSetUp)
}

/** 0..6 count of populated commissioning cells. */
function progressCount(s: CellState): number {
  let n = 0
  if (isNonEmpty(s.verifyIdentity)) n++
  if (isNonEmpty(s.motorHpField)) n++
  if (isNonEmpty(s.vfdHpField)) n++
  if (isNonEmpty(s.checkDirection)) n++
  if (isNonEmpty(s.beltTracked)) n++
  if (isNonEmpty(s.speedSetUp)) n++
  return n
}

/** "Jun 26 · J. Smith" from an ISO stamp + name (either may be missing). */
function formatStamp(at: string | null, by: string | null): string {
  const parts: string[] = []
  if (at) {
    const d = new Date(at)
    if (!isNaN(d.getTime())) parts.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  }
  if (by) parts.push(by)
  return parts.join(' · ')
}

type DoneFilter = 'all' | 'done' | 'notdone'
// Block-status filter: narrow to blocked belts, or only those a mechanic
// addressed on the cloud (the ones a tester should re-run the wizard on).
type BlockFilter = 'all' | 'blocked' | 'addressed'

// ── Sub-components ─────────────────────────────────────────────────

function StatusBadge({ state }: { state: CellState }) {
  const done = isDone(state)
  const progress = progressCount(state)

  if (done) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-green-600 text-white dark:bg-green-500">
        <CheckCircle2 className="h-3 w-3" />
        Done
      </span>
    )
  }

  if (progress > 0) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-800">
        <CircleDot className="h-3 w-3" />
        {progress}/6
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-muted text-muted-foreground border">
      <Circle className="h-3 w-3" />
      Not started
    </span>
  )
}

// ── Virtual scroll constants ───────────────────────────────────────

const ROW_HEIGHT = 48
const OVERSCAN = 5

// ── Grid column layout ─────────────────────────────────────────────
// Fixed pixel widths shared by the sticky header row AND every body row so the
// two stay aligned while the whole grid pans horizontally inside the single
// `overflow-auto` container. The order mirrors the cloud VFD commissioning
// table's commissioning columns (mapped to the fields the field /state returns).
type GridColKey =
  | 'device' | 'mcm'
  | 'verifyIdentity' | 'motorHpField' | 'vfdHpField' | 'checkDirection'
  | 'polarity' | 'speedSetUp' | 'beltTracked' | 'controlsVerified'
  | 'status' | 'blocked' | 'addressed'

interface GridCol { key: GridColKey; label: string; width: number }

// Trailing actions cell (Clear button + chevron). Not a labelled column.
const ACTIONS_WIDTH = 72

const GRID_COLUMNS: GridCol[] = [
  { key: 'device',           label: 'Device',            width: 200 },
  { key: 'mcm',              label: 'MCM',               width: 130 },
  { key: 'verifyIdentity',   label: 'Verify Identity',   width: 150 },
  { key: 'motorHpField',     label: 'Motor HP (Field)',  width: 130 },
  { key: 'vfdHpField',       label: 'VFD HP (Field)',    width: 130 },
  { key: 'checkDirection',   label: 'Check Direction',   width: 150 },
  { key: 'polarity',         label: 'Polarity',          width: 160 },
  { key: 'speedSetUp',       label: 'Speed Set Up',      width: 230 },
  { key: 'beltTracked',      label: 'Belt Tracked',      width: 150 },
  { key: 'controlsVerified', label: 'Controls Verified', width: 150 },
  { key: 'status',           label: 'Status',            width: 120 },
  { key: 'blocked',          label: 'Blocked',           width: 240 },
  { key: 'addressed',        label: 'Addressed',         width: 180 },
]

const GRID_WIDTH = GRID_COLUMNS.reduce((s, c) => s + c.width, 0) + ACTIONS_WIDTH

// The plain-text L2 cell columns (everything except the bespoke
// device/mcm/status/blocked/addressed cells), in render order. Used to map a
// column key → the CellState value it displays.
const L2_VALUE_KEYS = {
  verifyIdentity:   (c: CellState) => c.verifyIdentity,
  motorHpField:     (c: CellState) => c.motorHpField,
  vfdHpField:       (c: CellState) => c.vfdHpField,
  checkDirection:   (c: CellState) => c.checkDirection,
  polarity:         (c: CellState) => c.polarity,
  speedSetUp:       (c: CellState) => c.speedSetUp,
  beltTracked:      (c: CellState) => c.beltTracked,
  controlsVerified: (c: CellState) => c.controlsVerified,
} as const

/** A plain L2 value cell: the value (truncated + title tooltip) or a muted "—". */
function ValueCell({ value }: { value: string | null }) {
  if (!isNonEmpty(value)) {
    return <span className="text-muted-foreground/50">—</span>
  }
  return (
    <span className="block truncate" title={value!}>
      {value}
    </span>
  )
}

// ── Filter persistence ─────────────────────────────────────────────

const FILTER_STORAGE_KEY = (subsystemId: number) => `vfd-filters:${subsystemId}`

interface PersistedFilters {
  search: string
  mcm: string
  subsystem: string
  done: DoneFilter
  block: BlockFilter
}

function loadFilters(subsystemId: number): PersistedFilters {
  const fallback: PersistedFilters = { search: '', mcm: 'all', subsystem: 'all', done: 'all', block: 'all' }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY(subsystemId))
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return {
      search: typeof parsed.search === 'string' ? parsed.search : '',
      mcm: typeof parsed.mcm === 'string' ? parsed.mcm : 'all',
      subsystem: typeof parsed.subsystem === 'string' ? parsed.subsystem : 'all',
      done: parsed.done === 'done' || parsed.done === 'notdone' ? parsed.done : 'all',
      block: parsed.block === 'blocked' || parsed.block === 'addressed' ? parsed.block : 'all',
    }
  } catch {
    return fallback
  }
}

// ── Main Component ─────────────────────────────────────────────────

export function VfdCommissioningView({ devices: devicesProp, subsystemId, plcConnected }: VfdCommissioningViewProps) {
  const filterKey = subsystemId ?? 0
  const initialFilters = loadFilters(filterKey)
  // Devices either come from the prop or are self-loaded from /state.
  const [loadedDevices, setLoadedDevices] = useState<VfdDevice[]>([])
  const [rows, setRows] = useState<Map<string, RowState>>(new Map())
  const [searchTerm, setSearchTerm] = useState(initialFilters.search)
  const [mcmFilter, setMcmFilter] = useState<string>(initialFilters.mcm)
  const [subsystemFilter, setSubsystemFilter] = useState<string>(initialFilters.subsystem)
  const [doneFilter, setDoneFilter] = useState<DoneFilter>(initialFilters.done)
  const [blockFilter, setBlockFilter] = useState<BlockFilter>(initialFilters.block)
  const [wizardDevice, setWizardDevice] = useState<VfdDevice | null>(null)
  const [clearingName, setClearingName] = useState<string | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)

  const usePropDevices = Array.isArray(devicesProp) && devicesProp.length > 0
  const devices = usePropDevices ? devicesProp! : loadedDevices

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(800)

  // Persist filters per subsystem
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(FILTER_STORAGE_KEY(filterKey), JSON.stringify({
        search: searchTerm,
        mcm: mcmFilter,
        subsystem: subsystemFilter,
        done: doneFilter,
        block: blockFilter,
      } satisfies PersistedFilters))
    } catch { /* ignore quota errors */ }
  }, [filterKey, searchTerm, mcmFilter, subsystemFilter, doneFilter, blockFilter])

  // Load L2-cell-derived state + per-device meta + blocked/addressed annotations.
  // Pulled out so we can refresh after the wizard closes or after a Clear.
  const loadStates = useCallback(() => {
    fetch(`/api/vfd-commissioning/state`)
      .then(r => r.json())
      .then(data => {
        const map = new Map<string, RowState>()
        const devs: VfdDevice[] = []
        for (const row of (data.states || [])) {
          map.set(row.deviceName, {
            cells: {
              verifyIdentity:   row.cells?.verifyIdentity   ?? null,
              motorHpField:     row.cells?.motorHpField     ?? null,
              vfdHpField:       row.cells?.vfdHpField        ?? null,
              checkDirection:   row.cells?.checkDirection    ?? null,
              polarity:         row.cells?.polarity         ?? null,
              beltTracked:      row.cells?.beltTracked      ?? null,
              speedSetUp:       row.cells?.speedSetUp       ?? null,
              controlsVerified: row.cells?.controlsVerified ?? null,
              bumpBlocker:      row.cells?.bumpBlocker      ?? null,
            },
            blocked: Boolean(row.blocked),
            blockerParty: row.blockerParty ?? null,
            blockerReason: row.blockerReason ?? null,
            addressed: Boolean(row.addressed),
            addressedBy: row.addressedBy ?? null,
            addressedAt: row.addressedAt ?? null,
          })
          // Self-load device list from the state rows (meta included now).
          if (row.deviceId != null && row.deviceName) {
            devs.push({
              id: row.deviceId,
              deviceName: row.deviceName,
              mcm: row.mcm ?? '',
              subsystem: row.subsystem ?? '',
              sheetName: row.sheetName ?? undefined,
            })
          }
        }
        setRows(map)
        if (!usePropDevices) setLoadedDevices(devs)
      })
      .catch(() => {})
  }, [usePropDevices])

  useEffect(() => { loadStates() }, [loadStates])

  // When the tab opens, refresh the cloud-authoritative ADDRESSED flag for this
  // subsystem so a tech sees what a mechanic just marked on the cloud — without
  // waiting for the next SSE-reconnect catch-up. Best-effort; reloads state on
  // completion so any newly-mirrored ADDRESSED rows show immediately.
  useEffect(() => {
    if (!subsystemId || subsystemId <= 0) return
    let cancelled = false
    fetch('/api/vfd-commissioning/refresh-addressed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subsystemId }),
    })
      .then(r => r.json().catch(() => null))
      .then(() => { if (!cancelled) loadStates() })
      .catch(() => {})
    return () => { cancelled = true }
  }, [subsystemId, loadStates])

  /**
   * Wipe commissioning state for one VFD so it can be re-tested.
   * Deletes the six L2 commissioning cells (cloud-synced) and pulses
   * Invalidate_Map/HP/Direction to the PLC.
   */
  const handleClear = useCallback(async (device: VfdDevice) => {
    const ok = typeof window !== 'undefined'
      ? window.confirm(
          `Clear commissioning for ${device.deviceName}?\n\n` +
          `• L2 cells cleared: Verify Identity, Motor HP, VFD HP, Check Direction, Belt Tracked, Speed Set Up\n` +
          `• Cloud sync will push the clears\n` +
          `• PLC invalidate pulses will be sent` +
          (plcConnected ? '' : ' (PLC is offline — skipped)'),
        )
      : true
    if (!ok) return

    setClearingName(device.deviceName)
    setClearError(null)
    try {
      const res = await fetch('/api/vfd-commissioning/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceName: device.deviceName,
          sheetName: device.sheetName,
          clearPlc: plcConnected,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) {
        setClearError(data?.error || `Clear failed (${res.status})`)
      } else {
        const failed = (data.plcWrites || []).filter((w: any) => !w.ok)
        if (failed.length > 0) {
          setClearError(`L2 cleared (${data.cellsCleared} cells). PLC writes failed: ${failed.map((f: any) => `${f.field} — ${f.error}`).join('; ')}`)
        }
        await loadStates()
      }
    } catch (err) {
      setClearError(err instanceof Error ? err.message : String(err))
    }
    setClearingName(null)
  }, [plcConnected, loadStates])

  const getRow = useCallback((name: string): RowState =>
    rows.get(name) || emptyRow(),
  [rows])

  // Filters
  const mcmValues = useMemo(() => Array.from(new Set(devices.map(d => d.mcm).filter(Boolean))).sort(), [devices])
  const subsystemValues = useMemo(() => Array.from(new Set(devices.map(d => d.subsystem).filter(Boolean))).sort(), [devices])

  const filtered = useMemo(() => {
    return devices.filter(d => {
      if (searchTerm) {
        const q = searchTerm.toLowerCase()
        if (!d.deviceName.toLowerCase().includes(q) && !d.mcm.toLowerCase().includes(q) && !d.subsystem.toLowerCase().includes(q)) return false
      }
      if (mcmFilter !== 'all' && d.mcm !== mcmFilter) return false
      if (subsystemFilter !== 'all' && d.subsystem !== subsystemFilter) return false
      const row = getRow(d.deviceName)
      if (doneFilter !== 'all') {
        const done = isDone(row.cells)
        if (doneFilter === 'done' && !done) return false
        if (doneFilter === 'notdone' && done) return false
      }
      if (blockFilter === 'blocked' && !row.blocked) return false
      if (blockFilter === 'addressed' && !row.addressed) return false
      return true
    })
  }, [devices, searchTerm, mcmFilter, subsystemFilter, doneFilter, blockFilter, getRow])

  // Stats
  const doneCount = useMemo(
    () => devices.reduce((acc, d) => acc + (isDone(getRow(d.deviceName).cells) ? 1 : 0), 0),
    [devices, getRow],
  )
  const blockedCount = useMemo(
    () => devices.reduce((acc, d) => acc + (getRow(d.deviceName).blocked ? 1 : 0), 0),
    [devices, getRow],
  )
  const addressedCount = useMemo(
    () => devices.reduce((acc, d) => acc + (getRow(d.deviceName).addressed ? 1 : 0), 0),
    [devices, getRow],
  )

  // Virtual scroll
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => { for (const e of entries) setContainerHeight(e.contentRect.height) })
    obs.observe(el)
    setContainerHeight(el.clientHeight)
    return () => obs.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop)
  }, [])

  const { visibleRows, totalHeight, offsetY } = useMemo(() => {
    const total = filtered.length * ROW_HEIGHT
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const endIdx = Math.min(
      filtered.length,
      Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN,
    )
    return {
      visibleRows: filtered.slice(startIdx, endIdx),
      totalHeight: total,
      offsetY: startIdx * ROW_HEIGHT,
    }
  }, [filtered, scrollTop, containerHeight])

  if (devices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
        <Zap className="h-12 w-12 mb-4 opacity-30" />
        <p className="text-base font-medium">No VFD devices</p>
        <p className="text-sm mt-1">Import VFD device data to enable commissioning</p>
      </div>
    )
  }

  const hasActiveFilter = searchTerm || mcmFilter !== 'all' || subsystemFilter !== 'all' || doneFilter !== 'all' || blockFilter !== 'all'

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-card shrink-0">
        <Zap className="h-5 w-5 text-amber-500" />
        <span className="text-base font-semibold">VFD Commissioning</span>
        <Badge className="bg-muted text-foreground border font-mono text-xs px-2 py-0.5">{devices.length} devices</Badge>
        <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-800 font-mono text-xs px-2 py-0.5">
          {doneCount} done
        </Badge>
        {blockedCount > 0 && (
          <Badge className="bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800 font-mono text-xs px-2 py-0.5">
            {blockedCount} blocked
          </Badge>
        )}
        {addressedCount > 0 && (
          <Badge className="bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800 font-mono text-xs px-2 py-0.5">
            {addressedCount} addressed
          </Badge>
        )}
        <div className="flex-1" />
        <div className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border",
          plcConnected
            ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800"
            : "bg-muted text-muted-foreground border-border"
        )}>
          {plcConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          {plcConnected ? "PLC" : "Offline"}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-muted/30 shrink-0 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search device or MCM..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="h-8 w-52 pl-8 text-sm bg-background"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Done / Not Done filter */}
        <div className="flex items-center rounded-md border bg-background overflow-hidden h-8">
          {(['all', 'done', 'notdone'] as DoneFilter[]).map(opt => {
            const label = opt === 'all' ? 'All' : opt === 'done' ? 'Done' : 'Not done'
            const active = doneFilter === opt
            return (
              <button
                key={opt}
                onClick={() => setDoneFilter(opt)}
                className={cn(
                  "px-2.5 text-xs h-full border-r last:border-r-0 transition-colors",
                  active
                    ? opt === 'done'
                      ? "bg-green-600 text-white"
                      : opt === 'notdone'
                        ? "bg-muted-foreground/80 text-background"
                        : "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                {label}
              </button>
            )
          })}
        </div>

        {/* Block / Addressed filter — narrow to blocked belts or the ones a
            mechanic addressed on the cloud (ready for a tester to re-run). */}
        <div className="flex items-center rounded-md border bg-background overflow-hidden h-8">
          {(['all', 'blocked', 'addressed'] as BlockFilter[]).map(opt => {
            const label = opt === 'all' ? 'All' : opt === 'blocked' ? 'Blocked' : 'Addressed'
            const active = blockFilter === opt
            return (
              <button
                key={opt}
                onClick={() => setBlockFilter(opt)}
                className={cn(
                  "px-2.5 text-xs h-full border-r last:border-r-0 transition-colors",
                  active
                    ? opt === 'blocked'
                      ? "bg-amber-500 text-white"
                      : opt === 'addressed'
                        ? "bg-sky-500 text-white"
                        : "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                {label}
              </button>
            )
          })}
        </div>

        {mcmValues.length > 1 && (
          <select value={mcmFilter} onChange={e => setMcmFilter(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
            <option value="all">All MCMs</option>
            {mcmValues.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        {subsystemValues.length > 1 && (
          <select value={subsystemFilter} onChange={e => setSubsystemFilter(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
            <option value="all">All Subsystems</option>
            {subsystemValues.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {hasActiveFilter && (
          <button
            onClick={() => { setSearchTerm(''); setMcmFilter('all'); setSubsystemFilter('all'); setDoneFilter('all'); setBlockFilter('all') }}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <X className="h-3 w-3" />Clear
          </button>
        )}
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">{filtered.length} of {devices.length}</span>
      </div>

      {/* Grid — one horizontally-scrolling container holds a sticky header row
          plus the virtualized body. Header and rows share the SAME fixed column
          widths (GRID_COLUMNS) and the same `GRID_WIDTH` min-width, so they stay
          column-aligned and pan together horizontally. The body is virtualized
          on the vertical axis exactly as before. */}
      <div ref={scrollRef} className="flex-1 overflow-auto" onScroll={handleScroll}>
        <div style={{ minWidth: GRID_WIDTH, position: 'relative' }}>
          {/* Sticky header row */}
          <div
            className="sticky top-0 z-20 flex items-stretch border-b bg-muted/80 backdrop-blur supports-[backdrop-filter]:bg-muted/60"
            style={{ minWidth: GRID_WIDTH }}
          >
            {GRID_COLUMNS.map(col => (
              <div
                key={col.key}
                className="shrink-0 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground border-r last:border-r-0 flex items-center"
                style={{ width: col.width }}
                title={col.label}
              >
                <span className="truncate">{col.label}</span>
              </div>
            ))}
            {/* Actions spacer header (Clear / chevron) */}
            <div className="shrink-0" style={{ width: ACTIONS_WIDTH }} />
          </div>

          {/* Virtualized body */}
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${offsetY}px)` }}>
              {visibleRows.map(device => {
                const row = getRow(device.deviceName)
                const state = row.cells
                const done = isDone(state)
                const hasAnyState = progressCount(state) > 0
                const isClearing = clearingName === device.deviceName

                return (
                  <div
                    key={device.id}
                    className={cn(
                      "border-b flex items-stretch cursor-pointer transition-colors group",
                      done
                        ? "bg-green-100 hover:bg-green-200 dark:bg-green-900/40 dark:hover:bg-green-900/60 border-l-4 border-l-green-600 dark:border-l-green-500"
                        : row.blocked
                          ? "bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/30 dark:hover:bg-amber-950/50 border-l-4 border-l-amber-500"
                          : "hover:bg-muted/40"
                    )}
                    style={{ height: ROW_HEIGHT, minWidth: GRID_WIDTH }}
                    onClick={() => setWizardDevice(device)}
                  >
                    {GRID_COLUMNS.map(col => {
                      const cellClass = "shrink-0 px-3 flex items-center text-xs border-r last:border-r-0 min-w-0"
                      const style = { width: col.width }

                      // Device — icon + mono name
                      if (col.key === 'device') {
                        return (
                          <div key={col.key} className={cn(cellClass, "gap-2")} style={style}>
                            <Zap className={cn(
                              "h-4 w-4 shrink-0",
                              done ? "text-green-700 dark:text-green-300" : row.blocked ? "text-amber-600" : "text-amber-500"
                            )} />
                            <span className={cn(
                              "font-mono font-semibold truncate",
                              done && "text-green-900 dark:text-green-100"
                            )} title={device.deviceName}>
                              {device.deviceName}
                            </span>
                          </div>
                        )
                      }

                      // MCM
                      if (col.key === 'mcm') {
                        return (
                          <div key={col.key} className={cn(cellClass, done ? "text-green-800/80 dark:text-green-200/80" : "text-muted-foreground")} style={style}>
                            <span className="truncate" title={device.mcm}>{device.mcm || <span className="text-muted-foreground/50">—</span>}</span>
                          </div>
                        )
                      }

                      // Status badge
                      if (col.key === 'status') {
                        return (
                          <div key={col.key} className={cellClass} style={style}>
                            <StatusBadge state={state} />
                          </div>
                        )
                      }

                      // Blocked — party + reason
                      if (col.key === 'blocked') {
                        return (
                          <div key={col.key} className={cellClass} style={style}>
                            {row.blocked ? (
                              <span
                                className="inline-flex items-center gap-1 max-w-full text-[11px] text-amber-700 dark:text-amber-300"
                                title={`${row.blockerParty ? row.blockerParty + ': ' : ''}${row.blockerReason ?? 'Blocked'}`}
                              >
                                <AlertTriangle className="h-3 w-3 shrink-0" />
                                <span className="truncate">
                                  {row.blockerParty ? <span className="font-semibold">{row.blockerParty}: </span> : null}
                                  {row.blockerReason || 'Blocked'}
                                </span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground/50">—</span>
                            )}
                          </div>
                        )
                      }

                      // Addressed — read-only badge (mechanic marked on cloud)
                      if (col.key === 'addressed') {
                        return (
                          <div key={col.key} className={cellClass} style={style}>
                            {row.blocked && row.addressed ? (
                              <span
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-sky-100 text-sky-800 border border-sky-200 dark:bg-sky-900/40 dark:text-sky-200 dark:border-sky-800"
                                title={`Mechanic marked addressed${row.addressedBy ? ` by ${row.addressedBy}` : ''}${row.addressedAt ? ` on ${new Date(row.addressedAt).toLocaleString()}` : ''} — re-run the wizard`}
                              >
                                <Wrench className="h-3 w-3 shrink-0" />
                                <span className="truncate">Addressed{(() => { const s = formatStamp(row.addressedAt, row.addressedBy); return s ? ` · ${s}` : '' })()}</span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground/50">—</span>
                            )}
                          </div>
                        )
                      }

                      // Plain L2 commissioning value columns
                      const getValue = L2_VALUE_KEYS[col.key as keyof typeof L2_VALUE_KEYS]
                      return (
                        <div key={col.key} className={cn(cellClass, done && "text-green-900/90 dark:text-green-100/90")} style={style}>
                          <ValueCell value={getValue ? getValue(state) : null} />
                        </div>
                      )
                    })}

                    {/* Trailing actions: Clear button + chevron */}
                    <div className="shrink-0 flex items-center justify-end gap-1 pr-2" style={{ width: ACTIONS_WIDTH }}>
                      {hasAnyState && (
                        <button
                          title={`Clear commissioning for ${device.deviceName}`}
                          aria-label={`Clear commissioning for ${device.deviceName}`}
                          disabled={isClearing}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleClear(device)
                          }}
                          className={cn(
                            "inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors",
                            "text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40",
                            done ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100",
                            isClearing && "opacity-100 cursor-wait",
                          )}
                        >
                          {isClearing
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Trash2 className="h-4 w-4" />
                          }
                        </button>
                      )}
                      <ArrowRight className={cn(
                        "h-4 w-4 transition-opacity",
                        done
                          ? "text-green-700 dark:text-green-300 opacity-50 group-hover:opacity-100"
                          : "text-muted-foreground opacity-0 group-hover:opacity-100"
                      )} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {filtered.length === 0 && (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground" style={{ minWidth: GRID_WIDTH }}>
              No VFDs match the current filters.
            </div>
          )}
        </div>
      </div>

      {/* Clear error toast */}
      {clearError && (
        <div className="fixed bottom-4 right-4 z-50 max-w-md flex items-start gap-3 px-4 py-3 rounded-lg border bg-red-50 dark:bg-red-950/80 border-red-300 dark:border-red-800 shadow-lg">
          <div className="flex-1 text-sm text-red-900 dark:text-red-200">{clearError}</div>
          <button
            onClick={() => setClearError(null)}
            className="text-red-700 dark:text-red-300 hover:text-red-900 dark:hover:text-red-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Wizard Modal */}
      {wizardDevice && (
        <VfdWizardModal
          device={wizardDevice}
          subsystemId={subsystemId ?? 0}
          plcConnected={plcConnected}
          sheetName={wizardDevice.sheetName}
          onClose={() => {
            setWizardDevice(null)
            // Wizard may have written L2 cells — refresh the list state.
            loadStates()
          }}
        />
      )}
    </div>
  )
}
