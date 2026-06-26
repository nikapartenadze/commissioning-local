import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  GitBranch, ArrowLeft, RefreshCw, Loader2, Search, X,
  CheckCircle2, AlertTriangle, Circle, Wrench, Check, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ThemeToggle } from '@/components/theme-toggle'
import { AutstandLogo } from '@/components/autstand-logo'
import { useUser } from '@/lib/user-context'
import { VfdWizardModal } from '@/components/vfd-wizard-modal'

/**
 * Field-tool belt-tracking page — a local mirror of the cloud /belt-tracking
 * page. Reads LOCAL SQLite (GET /api/belt-tracking) so it works offline, and
 * lets a mechanic mark a BLOCKED belt as ADDRESSED (handoff: "physical issue
 * fixed — re-run the VFD wizard"), which records locally and pushes to the
 * cloud (POST /api/belt-tracking/addressed).
 *
 * ADDRESSED never clears the block and never enables tracking — that only
 * happens when a tester re-runs the VFD wizard and the bump passes. It is an
 * annotation surfaced only on BLOCKED belts.
 *
 * Phase 3 adds a "Run VFD Wizard" launcher per belt that opens the UNCHANGED
 * <VfdWizardModal> with identical props (device, subsystemId, plcConnected,
 * sheetName). This is a relocation-of-launch only — the wizard's PLC reads/
 * writes are untouched. Hard pre-launch guards mirror the architecture audit:
 *   (a) subsystemId must resolve (> 0) — else PLC writes route to the wrong
 *       controller on a multi-MCM/central setup;
 *   (b) PLC connection state is passed through verbatim — like
 *       vfd-commissioning-view, offline entry is allowed (the wizard is
 *       read-only offline and gates its own PLC writes);
 *   (c) every required wizard-write L2 column must exist on the sheet
 *       (route's `missingColumns`) — a missing column means a PLC bit is
 *       written with no durable L2 record (the CDW5 polarity incident);
 *   (d) one wizard open at a time (single `wizardDevice` state).
 */

type BeltStatus = 'Tracked' | 'Ready' | 'Blocked' | 'Not Ready'
const STATUS_OPTIONS: BeltStatus[] = ['Ready', 'Blocked', 'Tracked', 'Not Ready']

interface Belt {
  deviceId: number
  deviceName: string
  mcm: string | null
  subsystem: string | null
  sheetName: string
  subsystemId: number
  cells: {
    verifyIdentity: string | null
    motorHpField: string | null
    vfdHpField: string | null
    checkDirection: string | null
    beltTracked: string | null
  }
  blocked: boolean
  ready: boolean
  tracked: boolean
  status: BeltStatus
  blockerParty: string | null
  blockerReason: string | null
  addressed: boolean
  addressedBy: string | null
  addressedAt: string | null
  // Required wizard-write L2 columns absent from this belt's sheet. Non-empty
  // ⇒ launching the wizard would silently drop writes (CDW5 polarity incident),
  // so wizard launch is blocked until "pull latest L2" restores them.
  missingColumns: string[]
}

const STATUS_META: Record<BeltStatus, { cls: string; Icon: typeof CheckCircle2 }> = {
  Tracked: { cls: 'border-success/40 bg-success/10 text-success', Icon: CheckCircle2 },
  Ready: { cls: 'border-primary/40 bg-primary/10 text-primary', Icon: Check },
  Blocked: { cls: 'border-warning/50 bg-warning/15 text-warning', Icon: AlertTriangle },
  'Not Ready': { cls: 'border-border bg-muted text-muted-foreground', Icon: Circle },
}

function StatusBadge({ status }: { status: BeltStatus }) {
  const m = STATUS_META[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold', m.cls)}>
      <m.Icon className="h-3.5 w-3.5 shrink-0" />
      {status}
    </span>
  )
}

function formatStamp(at: string | null, by: string | null): string {
  const parts: string[] = []
  if (at) {
    const d = new Date(at)
    if (!isNaN(d.getTime())) parts.push(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  }
  if (by) parts.push(by)
  return parts.join(' · ')
}

export default function BeltTrackingPage() {
  const { currentUser } = useUser()
  const [belts, setBelts] = useState<Belt[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<BeltStatus | 'all'>('all')
  const [savingId, setSavingId] = useState<number | null>(null)
  // Single wizard open at a time (guard d). Holds the belt whose wizard is open.
  const [wizardBelt, setWizardBelt] = useState<Belt | null>(null)
  // Per-MCM PLC connection state, keyed by subsystemId. Sourced from the
  // canonical /api/plc/status?subsystemId= endpoint (the same per-MCM read the
  // commissioning page reconciles against). A belt's `plcConnected` is looked
  // up here; absence ⇒ treated as offline (the wizard still opens read-only,
  // matching vfd-commissioning-view, and gates its own PLC writes).
  const [plcBySubsystem, setPlcBySubsystem] = useState<Map<number, boolean>>(new Map())

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await fetch('/api/belt-tracking')
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
      setBelts(Array.isArray(d.belts) ? d.belts : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Distinct resolved subsystemIds across the belt list — the MCMs we need PLC
  // status for. Memoized string so the polling effect only re-arms when the set
  // of MCMs actually changes.
  const subsystemIdsKey = useMemo(() => {
    const ids = Array.from(new Set(belts.map(b => b.subsystemId).filter(id => id > 0)))
    ids.sort((a, b) => a - b)
    return ids.join(',')
  }, [belts])

  // Reconcile per-MCM PLC connection from /api/plc/status?subsystemId= for every
  // MCM that has belts, then re-poll every 20s — the same self-healing pull the
  // commissioning page uses. Best-effort: a fetch error leaves prior state
  // intact (an MCM stays whatever it last was; absent ⇒ offline).
  useEffect(() => {
    const ids = subsystemIdsKey ? subsystemIdsKey.split(',').map(Number) : []
    if (ids.length === 0) return
    let cancelled = false

    const reconcile = async () => {
      const results = await Promise.all(ids.map(async (id) => {
        try {
          const res = await fetch(`/api/plc/status?subsystemId=${id}`, { signal: AbortSignal.timeout(8000) })
          if (!res.ok) return [id, undefined] as const
          const body = await res.json() as { connected?: boolean }
          return [id, !!body.connected] as const
        } catch {
          return [id, undefined] as const
        }
      }))
      if (cancelled) return
      setPlcBySubsystem(prev => {
        const next = new Map(prev)
        for (const [id, connected] of results) {
          if (connected !== undefined) next.set(id, connected)
        }
        return next
      })
    }

    void reconcile()
    const t = setInterval(() => { void reconcile() }, 20_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [subsystemIdsKey])

  // Toggle ADDRESSED. Optimistically update local UI immediately (offline-safe —
  // the server records it locally first), then reconcile from a reload.
  const toggleAddressed = useCallback(async (belt: Belt) => {
    if (!belt.blocked || belt.subsystemId <= 0) return
    const next = !belt.addressed
    setSavingId(belt.deviceId)
    // Optimistic local update.
    setBelts(prev => prev.map(b =>
      b.deviceId === belt.deviceId
        ? {
            ...b,
            addressed: next,
            addressedBy: next ? (currentUser?.fullName ?? null) : null,
            addressedAt: next ? new Date().toISOString() : null,
          }
        : b,
    ))
    try {
      const r = await fetch('/api/belt-tracking/addressed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subsystemId: belt.subsystemId,
          deviceName: belt.deviceName,
          addressed: next,
          updatedBy: currentUser?.fullName || undefined,
        }),
      })
      const d = await r.json().catch(() => null)
      if (!r.ok || d?.ok === false) {
        throw new Error(d?.error || `HTTP ${r.status}`)
      }
    } catch (e) {
      // Roll back optimistic change on a definite failure and surface it.
      setError(e instanceof Error ? e.message : String(e))
      await load()
    } finally {
      setSavingId(null)
    }
  }, [currentUser, load])

  const mcmValues = useMemo(
    () => Array.from(new Set(belts.map(b => b.mcm).filter(Boolean))) as string[],
    [belts],
  )

  const counts = useMemo(() => {
    const c: Record<BeltStatus, number> = { Tracked: 0, Ready: 0, Blocked: 0, 'Not Ready': 0 }
    for (const b of belts) c[b.status]++
    return c
  }, [belts])

  const filtered = useMemo(() => {
    return belts.filter(b => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        if (
          !b.deviceName.toLowerCase().includes(q) &&
          !(b.mcm ?? '').toLowerCase().includes(q) &&
          !(b.subsystem ?? '').toLowerCase().includes(q)
        ) return false
      }
      return true
    })
  }, [belts, statusFilter, search])

  const hasFilter = search !== '' || statusFilter !== 'all'

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* ───────── Header ───────── */}
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center gap-4">
          <AutstandLogo className="h-5 sm:h-6 shrink-0" />
          <div className="h-6 w-px bg-border hidden sm:block" />
          <div className="min-w-0 flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-primary shrink-0" />
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-tight leading-none">Belt Tracking</h1>
              <p className="text-[11px] text-muted-foreground mt-1">
                {belts.length} belt{belts.length === 1 ? '' : 's'} · {mcmValues.length || 0} MCM{mcmValues.length === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          <div className="flex-1" />
          <Button onClick={() => { setLoading(true); void load() }} disabled={loading} size="sm" variant="outline" className="gap-1.5">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <Button asChild size="icon" variant="ghost" title="Back to controllers"><a href="/mcm"><ArrowLeft className="h-4 w-4" /></a></Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-5">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)} className="hover:opacity-70"><X className="h-4 w-4" /></button>
          </div>
        )}

        {/* Summary chips + filters */}
        {!loading && belts.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setStatusFilter('all')}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                statusFilter === 'all' ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              All {belts.length}
            </button>
            {STATUS_OPTIONS.map(s => {
              const m = STATUS_META[s]
              const active = statusFilter === s
              return (
                <button
                  key={s}
                  onClick={() => setStatusFilter(active ? 'all' : s)}
                  className={cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors', m.cls, active && 'ring-2 ring-offset-1 ring-offset-background ring-current')}
                >
                  <m.Icon className="h-3.5 w-3.5" />
                  {s} {counts[s]}
                </button>
              )
            })}
            <div className="flex-1" />
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search device or MCM…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-8 w-52 pl-8 text-sm bg-background"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="grid place-items-center py-24 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin mr-2" />Loading…</div>
        ) : belts.length === 0 ? (
          <div className="grid place-items-center py-20 text-center">
            <GitBranch className="h-10 w-10 text-muted-foreground mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground max-w-sm">No belt VFDs found. Pull the VFD/APF L2 sheet from the cloud to populate this list.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground text-sm">No belts match the current filters.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Belt VFD</th>
                  <th className="px-3 py-2 font-medium">MCM</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Details</th>
                  <th className="px-3 py-2 font-medium text-right">Mechanic</th>
                  <th className="px-3 py-2 font-medium text-right">Wizard</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(belt => {
                  const isSaving = savingId === belt.deviceId
                  const cannotAddress = belt.subsystemId <= 0
                  // ── Wizard-launch guards ──────────────────────────────
                  // (a) subsystemId must resolve, or PLC writes route to the
                  //     wrong controller. Same condition as `cannotAddress`.
                  const unresolvedSubsystem = belt.subsystemId <= 0
                  // (c) every required wizard-write L2 column must be present,
                  //     else the wizard silently drops writes.
                  const missing = belt.missingColumns ?? []
                  const hasMissingColumns = missing.length > 0
                  const wizardBlocked = unresolvedSubsystem || hasMissingColumns
                  // (b) PLC connection passed through verbatim (offline ⇒
                  //     read-only entry, exactly like vfd-commissioning-view).
                  const beltPlcConnected = plcBySubsystem.get(belt.subsystemId) ?? false
                  const wizardTitle = unresolvedSubsystem
                    ? "Cannot resolve this belt's subsystem — pull the L2 sheet per-MCM before running the wizard"
                    : hasMissingColumns
                      ? `Sheet is missing required column(s): ${missing.join(', ')} — pull latest L2 before running the wizard`
                      : beltPlcConnected
                        ? 'Run the VFD wizard for this belt'
                        : 'Run the VFD wizard (PLC offline — read-only, no PLC writes)'
                  return (
                    <tr
                      key={belt.deviceId}
                      className={cn(
                        'border-b border-border last:border-0 transition-colors',
                        belt.status === 'Blocked' ? 'bg-warning/[0.04] hover:bg-warning/[0.08]' : 'hover:bg-muted/40',
                      )}
                    >
                      <td className="px-3 py-2.5 font-mono font-semibold">{belt.deviceName}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{belt.mcm || belt.subsystem || '—'}</td>
                      <td className="px-3 py-2.5"><StatusBadge status={belt.status} /></td>
                      <td className="px-3 py-2.5 max-w-[280px]">
                        {belt.blocked ? (
                          <span className="text-warning text-xs">
                            {belt.blockerParty ? <span className="font-semibold">{belt.blockerParty}: </span> : null}
                            {belt.blockerReason || 'Blocked'}
                          </span>
                        ) : belt.status === 'Ready' ? (
                          <span className="text-xs text-muted-foreground">Controls complete — ready to track</span>
                        ) : belt.status === 'Tracked' ? (
                          <span className="text-xs text-success">Belt tracked</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Controls incomplete</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {belt.blocked ? (
                          <div className="inline-flex flex-col items-end gap-0.5">
                            <button
                              onClick={() => toggleAddressed(belt)}
                              disabled={isSaving || cannotAddress}
                              title={cannotAddress ? 'Cannot resolve this belt\'s subsystem — pull the L2 sheet per-MCM to enable ADDRESSED' : belt.addressed ? 'Undo ADDRESSED' : 'Mark physical issue addressed (re-run the VFD wizard)'}
                              className={cn(
                                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                                belt.addressed
                                  ? 'border-sky-500/50 bg-sky-500/15 text-sky-600 dark:text-sky-400 hover:bg-sky-500/25'
                                  : 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20',
                              )}
                            >
                              {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : belt.addressed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Wrench className="h-3.5 w-3.5" />}
                              {belt.addressed ? 'Addressed' : 'Mark addressed'}
                            </button>
                            {belt.addressed && (belt.addressedAt || belt.addressedBy) && (
                              <span className="text-[10px] text-muted-foreground">{formatStamp(belt.addressedAt, belt.addressedBy)}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          onClick={() => { if (!wizardBlocked) setWizardBelt(belt) }}
                          disabled={wizardBlocked}
                          title={wizardTitle}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                            'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20',
                          )}
                        >
                          <Zap className="h-3.5 w-3.5" />
                          Run VFD Wizard
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {hasFilter && !loading && (
          <div className="text-center">
            <button onClick={() => { setSearch(''); setStatusFilter('all') }} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <X className="h-3 w-3" />Clear filters
            </button>
          </div>
        )}
      </main>

      {/* VFD wizard — UNCHANGED component, launched with identical props. One
          open at a time (guard d, single wizardBelt state). On close, refresh
          the belt list since the wizard may have written L2 cells / cleared a
          blocker, exactly like vfd-commissioning-view. */}
      {wizardBelt && (
        <VfdWizardModal
          device={{
            id: wizardBelt.deviceId,
            deviceName: wizardBelt.deviceName,
            mcm: wizardBelt.mcm ?? '',
            subsystem: wizardBelt.subsystem ?? '',
          }}
          subsystemId={wizardBelt.subsystemId}
          plcConnected={plcBySubsystem.get(wizardBelt.subsystemId) ?? false}
          sheetName={wizardBelt.sheetName}
          onClose={() => {
            setWizardBelt(null)
            void load()
          }}
        />
      )}
    </div>
  )
}
