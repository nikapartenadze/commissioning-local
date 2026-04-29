import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, X, UserCog, PieChart } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useBeltTracking, trackedPayload, untrackedPayload } from '@/lib/belt-tracking/use-belt-tracking'
import { ThemeToggle } from '@/components/theme-toggle'
import { SyncStatusPill } from './sync-status-pill'
import { MechanicNamePrompt } from './mechanic-name-prompt'
import { ReadyCell, TrackedToggleCell } from './cells'
import { ProgressChartDialog } from './progress-chart-dialog'
import { FilterPopover } from './filter-popover'

type StatusFilter = 'tracked' | 'ready' | 'not_ready'
const STATUS_LABELS: Record<StatusFilter, string> = {
  tracked: 'Tracked',
  ready: 'Ready',
  not_ready: 'Not Ready',
}

const MECHANIC_NAME_KEY = 'mechanic-name'

/**
 * Belt Tracking — Mechanics-only view of the Functional L2 spreadsheet,
 * filtered to three columns (VFD, Ready for Tracking, Belt Tracked).
 *
 * Visually mirrors fv-sheet-grid.tsx so it reads as the same surface.
 * Theme follows the global shadcn theme (toggle in the header).
 *
 * Belt Tracked is a tap-cycle button (TrackedToggleCell) — empty cells
 * show a "—" affordance so the button reads as actionable from across
 * the room. The underlying L2 cell still stores text ("Yes" / null) so
 * the rest of the FV grid renders the same data correctly.
 */
export function BeltTrackingPage() {
  const [mechanicName, setMechanicName] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    return localStorage.getItem(MECHANIC_NAME_KEY)
  })

  const { vfds, loading, loadError, pill, markTracked } =
    useBeltTracking(mechanicName)

  const [search, setSearch] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [chartOpen, setChartOpen] = useState(false)
  // null = all (default), [] = none, [...] = subset — mirrors FV grid convention
  const [mcmFilter, setMcmFilter]             = useState<string[] | null>(null)
  const [subsystemFilter, setSubsystemFilter] = useState<string[] | null>(null)
  const [statusFilter, setStatusFilter]       = useState<string[] | null>(null)

  // Distinct values for filter dropdowns — recomputed when the device
  // list changes (e.g. after a cloud pull brings in new MCMs).
  const allMcms = useMemo(
    () => Array.from(new Set(vfds.map(v => v.mcm).filter((m): m is string => !!m))).sort(),
    [vfds],
  )
  const allSubsystems = useMemo(
    () => Array.from(new Set(vfds.map(v => v.subsystem).filter((s): s is string => !!s))).sort(),
    [vfds],
  )
  const allStatuses: StatusFilter[] = ['tracked', 'ready', 'not_ready']

  // Apply all filters then sort. Each filter follows FV grid convention:
  // null = pass-all, [] = pass-none, [..] = subset.
  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase()
    const statusOf = (v: typeof vfds[0]): StatusFilter =>
      v.tracked ? 'tracked' : v.ready ? 'ready' : 'not_ready'
    const matches = (v: typeof vfds[0]) => {
      if (term.length > 0 && !v.deviceName.toLowerCase().includes(term)) return false
      if (mcmFilter !== null && !mcmFilter.includes(v.mcm ?? '')) return false
      if (subsystemFilter !== null && !subsystemFilter.includes(v.subsystem ?? '')) return false
      if (statusFilter !== null && !statusFilter.includes(statusOf(v))) return false
      return true
    }
    const filtered = vfds.filter(matches)
    const rank = (v: typeof vfds[0]) => {
      if (v.ready && !v.tracked) return 0
      if (v.tracked) return 1
      return 2
    }
    return [...filtered].sort((a, b) => {
      const r = rank(a) - rank(b)
      if (r !== 0) return r
      const m = (a.mcm ?? '').localeCompare(b.mcm ?? '')
      if (m !== 0) return m
      return a.deviceName.localeCompare(b.deviceName)
    })
  }, [vfds, search, mcmFilter, subsystemFilter, statusFilter])

  useEffect(() => {
    if (!errorMessage) return
    const t = window.setTimeout(() => setErrorMessage(null), 4000)
    return () => window.clearTimeout(t)
  }, [errorMessage])

  function handleSubmitName(name: string) {
    localStorage.setItem(MECHANIC_NAME_KEY, name)
    setMechanicName(name)
  }
  function handleChangeName() {
    localStorage.removeItem(MECHANIC_NAME_KEY)
    setMechanicName(null)
  }

  async function handleToggle(deviceId: number, next: boolean) {
    try {
      await markTracked(deviceId, next ? trackedPayload() : untrackedPayload())
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save — try again.')
    }
  }

  if (!mechanicName) {
    return <MechanicNamePrompt onSubmit={handleSubmitName} />
  }

  const totalReady   = vfds.filter(v => v.ready && !v.tracked).length
  const totalTracked = vfds.filter(v => v.tracked).length
  const totalPending = vfds.filter(v => !v.ready && !v.tracked).length

  // Virtualization — only render visible rows. Each row is a fixed
  // 64px (matches min-h-16 in cells.tsx). Without this, 1000+ VFDs
  // bog the page down on a tablet.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 65,
    overscan: 8,
  })

  return (
    <div className="min-h-screen w-screen flex flex-col bg-background text-foreground">
      {/* ─────────── HEADER ─────────── */}
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 sm:px-6 h-16 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex flex-col min-w-0">
          <h1 className="text-lg font-bold tracking-tight leading-none">
            Belt Tracking
          </h1>
          <span className="text-xs text-muted-foreground font-mono mt-1">
            Project · all subsystems
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SyncStatusPill state={pill} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setChartOpen(true)}
            className="h-9 gap-2 text-xs"
            title="Show progress chart"
          >
            <PieChart className="h-4 w-4" />
            <span className="hidden sm:inline">Progress</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleChangeName}
            className="hidden sm:flex h-9 gap-2 text-xs"
            title={`Signed in as ${mechanicName}`}
          >
            <UserCog className="h-4 w-4" />
            <span className="font-mono">{mechanicName}</span>
            <span className="text-muted-foreground/70">change</span>
          </Button>
          {/* On phones we drop the name and keep just the pencil icon */}
          <Button
            variant="outline"
            size="icon"
            onClick={handleChangeName}
            className="sm:hidden h-9 w-9"
            title={`Signed in as ${mechanicName} — tap to change`}
          >
            <UserCog className="h-4 w-4" />
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {/* ─────────── STATS + FILTERS ─────────── */}
      <div className="border-b bg-muted/30 px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground font-bold tabular-nums text-lg">{totalReady}</span>
          <span className="text-muted-foreground text-xs uppercase tracking-wider">Ready</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-emerald-600 dark:text-emerald-400 font-bold tabular-nums text-lg">{totalTracked}</span>
          <span className="text-muted-foreground text-xs uppercase tracking-wider">Tracked</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground/70 font-bold tabular-nums text-lg">{totalPending}</span>
          <span className="text-muted-foreground text-xs uppercase tracking-wider">Pending</span>
        </div>

        {/* Filters — multi-select popovers, same convention as the FV grid */}
        {vfds.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <FilterPopover
              label="MCM"
              allValues={allMcms}
              selected={mcmFilter}
              onSelect={setMcmFilter}
            />
            <FilterPopover
              label="Subsystem"
              allValues={allSubsystems}
              selected={subsystemFilter}
              onSelect={setSubsystemFilter}
            />
            <FilterPopover
              label="Status"
              allValues={allStatuses.map(s => STATUS_LABELS[s])}
              selected={statusFilter ? statusFilter.map(s => STATUS_LABELS[s as StatusFilter]) : null}
              onSelect={(next) => {
                if (next === null) { setStatusFilter(null); return }
                const reverse: Record<string, StatusFilter> = Object.fromEntries(
                  allStatuses.map(s => [STATUS_LABELS[s], s])
                )
                setStatusFilter(next.map(label => reverse[label]).filter(Boolean))
              }}
            />
          </div>
        )}

        {/* Search — pushed right */}
        {vfds.length > 0 && (
          <div className="relative ml-auto w-full sm:w-72">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              className="w-full h-9 pl-10 pr-9 text-sm rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Filter VFD..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              spellCheck={false}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-muted-foreground hover:text-foreground rounded"
                aria-label="Clear"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* ─────────── BODY ─────────── */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {loading ? (
          <div className="text-center py-20 text-muted-foreground text-base">Loading…</div>
        ) : loadError ? (
          <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
            <div className="font-semibold text-destructive">Couldn't load belt tracking</div>
            <div className="font-mono text-xs mt-1 text-foreground">{loadError.error}</div>
            {loadError.code === 'no_subsystem' && (
              <div className="text-xs mt-2 text-muted-foreground">
                The server needs an active subsystem before mechanics can use this page.
              </div>
            )}
            {loadError.code === 'no_belt_column' && (
              <div className="text-xs mt-2 text-muted-foreground">
                Pull the L2 schema from cloud first, then refresh.
              </div>
            )}
          </div>
        ) : vfds.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground text-base">
            No VFDs yet. Once IOs are pulled from cloud, they'll appear here.
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground text-base">
            No VFDs match the current filters.
          </div>
        ) : (
          <>
            {/* Sticky header — outside the scroll container so the sticky
                interaction doesn't fight the virtualizer's absolute rows. */}
            <div
              role="row"
              className="grid grid-cols-[28%_24%_28%_20%] border-b border-zinc-200 dark:border-zinc-800 bg-background shrink-0"
            >
              <div className="px-4 py-3 text-left text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground border-r border-zinc-200 dark:border-zinc-800">
                VFD
              </div>
              <div className="px-4 py-3 text-left text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground border-r border-zinc-200 dark:border-zinc-800">
                Subsystem
              </div>
              <div className="px-4 py-3 text-left text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground border-r border-zinc-200 dark:border-zinc-800">
                Ready for Tracking
              </div>
              <div className="px-4 py-3 text-left text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                Belt Tracked
              </div>
            </div>

            {/* Virtualized body — only the rows in view are rendered. */}
            <div ref={scrollRef} className="flex-1 overflow-auto">
              <div
                style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
              >
                {rowVirtualizer.getVirtualItems().map(vi => {
                  const v = sorted[vi.index]
                  return (
                    <div
                      key={v.deviceId}
                      role="row"
                      className="absolute left-0 right-0 grid grid-cols-[28%_24%_28%_20%] border-b border-zinc-200 dark:border-zinc-800"
                      style={{
                        top: 0,
                        height: 65,
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      {/* VFD column anchors at bg-background — row state lives
                          in the action cells, not in a row tint. */}
                      <div className="border-r border-zinc-200 dark:border-zinc-800 bg-background flex items-center gap-3 px-4 min-h-16">
                        <span className="font-mono font-bold text-base text-foreground tracking-tight">
                          {v.deviceName}
                        </span>
                        {v.mcm && (
                          <span className="font-mono text-[10px] uppercase tracking-[0.16em] font-bold text-muted-foreground">
                            {v.mcm}
                          </span>
                        )}
                      </div>
                      <div className="border-r border-zinc-200 dark:border-zinc-800 bg-background flex items-center px-4 text-sm text-foreground/80 truncate">
                        {v.subsystem ?? <span className="opacity-40 text-lg">—</span>}
                      </div>
                      <div className="border-r border-zinc-200 dark:border-zinc-800">
                        <ReadyCell ready={v.ready} />
                      </div>
                      <div>
                        <TrackedToggleCell
                          tracked={v.tracked}
                          disabled={!v.ready}
                          onChange={(next) => handleToggle(v.deviceId, next)}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </main>

      {/* ─────────── PROGRESS CHART ─────────── */}
      <ProgressChartDialog
        open={chartOpen}
        onOpenChange={setChartOpen}
        ready={totalReady}
        tracked={totalTracked}
        notReady={totalPending}
      />

      {/* ─────────── ERROR TOAST ─────────── */}
      {errorMessage && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 max-w-[90%] px-4 py-2 rounded-md bg-destructive text-destructive-foreground text-sm font-semibold shadow-lg z-20"
          role="status"
          aria-live="polite"
        >
          {errorMessage}
        </div>
      )}
    </div>
  )
}
