"use client"

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  Zap, Search, X, Wifi, WifiOff, ArrowRight, CheckCircle2, Circle, CircleDot,
  Trash2, Loader2,
} from 'lucide-react'
import { VfdWizardModal } from './vfd-wizard-modal'

// ── Types ──────────────────────────────────────────────────────────

interface VfdDevice { id: number; deviceName: string; mcm: string; subsystem: string; sheetName?: string }

interface VfdCommissioningViewProps {
  devices: VfdDevice[]
  subsystemId: number
  plcConnected: boolean
}

/**
 * Commissioning state for one VFD derived ENTIRELY from the L2 spreadsheet.
 * There is no separate VfdCheckState table anymore — the L2 spreadsheet
 * (stored in local SQLite AND synced to cloud) is the single source of truth.
 *
 * A cell holds a string value when that wizard step has completed. Values are:
 *   - motorHpField / vfdHpField    → numeric text from Step 2 (e.g. "5.0")
 *   - readyForTracking / beltTracked → INITIALS DATE stamp (e.g. "ASH 9/5")
 *   - speedSetUp                   → enriched stamp from Step 5
 *                                     e.g. "ASH 9/5 · 200 FPM @ 25.30 RVS"
 */
interface CellState {
  motorHpField:     string | null
  vfdHpField:       string | null
  readyForTracking: string | null
  beltTracked:      string | null
  speedSetUp:       string | null
}

// ── Helpers ────────────────────────────────────────────────────────

const emptyCells = (): CellState => ({
  motorHpField: null, vfdHpField: null, readyForTracking: null,
  beltTracked: null, speedSetUp: null,
})

function isNonEmpty(v: string | null): boolean {
  return v != null && v.trim() !== ''
}

/** All five commissioning L2 cells populated = done. */
function isDone(s: CellState): boolean {
  return isNonEmpty(s.motorHpField)
    && isNonEmpty(s.vfdHpField)
    && isNonEmpty(s.readyForTracking)
    && isNonEmpty(s.beltTracked)
    && isNonEmpty(s.speedSetUp)
}

/** 0..5 count of populated commissioning cells. */
function progressCount(s: CellState): number {
  let n = 0
  if (isNonEmpty(s.motorHpField)) n++
  if (isNonEmpty(s.vfdHpField)) n++
  if (isNonEmpty(s.readyForTracking)) n++
  if (isNonEmpty(s.beltTracked)) n++
  if (isNonEmpty(s.speedSetUp)) n++
  return n
}

type DoneFilter = 'all' | 'done' | 'notdone'

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
        {progress}/5
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

// ── Filter persistence ─────────────────────────────────────────────

const FILTER_STORAGE_KEY = (subsystemId: number) => `vfd-filters:${subsystemId}`

interface PersistedFilters {
  search: string
  mcm: string
  subsystem: string
  done: DoneFilter
}

function loadFilters(subsystemId: number): PersistedFilters {
  if (typeof window === 'undefined') return { search: '', mcm: 'all', subsystem: 'all', done: 'all' }
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY(subsystemId))
    if (!raw) return { search: '', mcm: 'all', subsystem: 'all', done: 'all' }
    const parsed = JSON.parse(raw)
    return {
      search: typeof parsed.search === 'string' ? parsed.search : '',
      mcm: typeof parsed.mcm === 'string' ? parsed.mcm : 'all',
      subsystem: typeof parsed.subsystem === 'string' ? parsed.subsystem : 'all',
      done: parsed.done === 'done' || parsed.done === 'notdone' ? parsed.done : 'all',
    }
  } catch {
    return { search: '', mcm: 'all', subsystem: 'all', done: 'all' }
  }
}

// ── Main Component ─────────────────────────────────────────────────

export function VfdCommissioningView({ devices, subsystemId, plcConnected }: VfdCommissioningViewProps) {
  const initialFilters = loadFilters(subsystemId)
  const [states, setStates] = useState<Map<string, CellState>>(new Map())
  const [searchTerm, setSearchTerm] = useState(initialFilters.search)
  const [mcmFilter, setMcmFilter] = useState<string>(initialFilters.mcm)
  const [subsystemFilter, setSubsystemFilter] = useState<string>(initialFilters.subsystem)
  const [doneFilter, setDoneFilter] = useState<DoneFilter>(initialFilters.done)
  const [wizardDevice, setWizardDevice] = useState<VfdDevice | null>(null)
  const [clearingName, setClearingName] = useState<string | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(800)

  // Persist filters per subsystem
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(FILTER_STORAGE_KEY(subsystemId), JSON.stringify({
        search: searchTerm,
        mcm: mcmFilter,
        subsystem: subsystemFilter,
        done: doneFilter,
      } satisfies PersistedFilters))
    } catch { /* ignore quota errors */ }
  }, [subsystemId, searchTerm, mcmFilter, subsystemFilter, doneFilter])

  // Load L2-cell-derived state. Pulled out so we can refresh after the wizard
  // closes or after a Clear action.
  const loadStates = useCallback(() => {
    fetch(`/api/vfd-commissioning/state`)
      .then(r => r.json())
      .then(data => {
        const map = new Map<string, CellState>()
        for (const row of (data.states || [])) {
          map.set(row.deviceName, {
            motorHpField:     row.cells?.motorHpField     ?? null,
            vfdHpField:       row.cells?.vfdHpField       ?? null,
            readyForTracking: row.cells?.readyForTracking ?? null,
            beltTracked:      row.cells?.beltTracked      ?? null,
            speedSetUp:       row.cells?.speedSetUp       ?? null,
          })
        }
        setStates(map)
      })
      .catch(() => {})
  }, [])

  useEffect(() => { loadStates() }, [loadStates])

  /**
   * Wipe commissioning state for one VFD so it can be re-tested.
   * Deletes the five L2 commissioning cells (cloud-synced) and pulses
   * Invalidate_Map/HP/Direction to the PLC.
   */
  const handleClear = useCallback(async (device: VfdDevice) => {
    const ok = typeof window !== 'undefined'
      ? window.confirm(
          `Clear commissioning for ${device.deviceName}?\n\n` +
          `• L2 cells cleared: Motor HP, VFD HP, Ready For Tracking, Belt Tracked, Speed Set Up\n` +
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

  const getState = useCallback((name: string): CellState =>
    states.get(name) || emptyCells(),
  [states])

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
      if (doneFilter !== 'all') {
        const done = isDone(getState(d.deviceName))
        if (doneFilter === 'done' && !done) return false
        if (doneFilter === 'notdone' && done) return false
      }
      return true
    })
  }, [devices, searchTerm, mcmFilter, subsystemFilter, doneFilter, getState])

  // Stats
  const doneCount = useMemo(
    () => devices.reduce((acc, d) => acc + (isDone(getState(d.deviceName)) ? 1 : 0), 0),
    [devices, getState],
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

  const hasActiveFilter = searchTerm || mcmFilter !== 'all' || subsystemFilter !== 'all' || doneFilter !== 'all'

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
        <Badge className="bg-muted text-muted-foreground border font-mono text-xs px-2 py-0.5">
          {devices.length - doneCount} remaining
        </Badge>
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
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-muted/30 shrink-0">
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
            onClick={() => { setSearchTerm(''); setMcmFilter('all'); setSubsystemFilter('all'); setDoneFilter('all') }}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <X className="h-3 w-3" />Clear
          </button>
        )}
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">{filtered.length} of {devices.length}</span>
      </div>

      {/* Virtualized list */}
      <div ref={scrollRef} className="flex-1 overflow-auto" onScroll={handleScroll}>
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {visibleRows.map(device => {
              const state = getState(device.deviceName)
              const done = isDone(state)
              const hasAnyState = progressCount(state) > 0
              const isClearing = clearingName === device.deviceName

              return (
                <div
                  key={device.id}
                  className={cn(
                    "border-b flex items-center gap-3 px-4 cursor-pointer transition-colors group",
                    done
                      ? "bg-green-100 hover:bg-green-200 dark:bg-green-900/40 dark:hover:bg-green-900/60 border-l-4 border-l-green-600 dark:border-l-green-500"
                      : "hover:bg-muted/40"
                  )}
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => setWizardDevice(device)}
                >
                  <Zap className={cn(
                    "h-4 w-4 shrink-0",
                    done ? "text-green-700 dark:text-green-300" : "text-amber-500"
                  )} />
                  <span className={cn(
                    "font-mono font-semibold text-sm w-[180px] truncate",
                    done && "text-green-900 dark:text-green-100"
                  )}>
                    {device.deviceName}
                  </span>
                  <span className={cn(
                    "text-xs w-[160px] truncate",
                    done ? "text-green-800/80 dark:text-green-200/80" : "text-muted-foreground"
                  )}>
                    {device.mcm}
                  </span>
                  <StatusBadge state={state} />
                  <div className="flex-1" />

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
              )
            })}
            {filtered.length === 0 && (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                No VFDs match the current filters.
              </div>
            )}
          </div>
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
          subsystemId={subsystemId}
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
