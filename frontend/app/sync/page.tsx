import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Loader2, ShieldCheck, CloudOff, CloudUpload,
  AlertTriangle, CheckCircle2, XCircle, RotateCcw, Trash2, ChevronDown,
  ChevronRight, Info, Clock, Wifi, HelpCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { ThemeToggle } from '@/components/theme-toggle'
import { AutstandLogo } from '@/components/autstand-logo'
import { SyncCompare } from '@/components/sync-compare'
import { authFetch } from '@/lib/api-config'
import { toast } from '@/hooks/use-toast'

// ── Contract types (must match the backend /api/sync/queue contract) ──────────
type Kind = 'io' | 'l2' | 'blocker'
type QueueStatus = 'pending' | 'parked' | 'orphaned'
type Classification = 'gone_on_cloud' | 'version_conflict' | 'transient' | 'unknown'

interface QueueItem {
  kind: Kind
  id: number
  subsystemId: number | null
  mcm: string | null
  title: string
  subtitle: string | null
  value: string | null
  status: QueueStatus
  classification: Classification
  reason: string
  lastError: string | null
  retryCount: number
  createdAt: string | null
  ageMinutes: number | null
}

interface QueueSummary {
  pending: number
  parked: number
  orphaned: number
  byClassification: Record<Classification, number>
}

interface QueueResponse {
  summary: QueueSummary
  items: QueueItem[]
}

type ActionBody = {
  action: 'retry' | 'discard'
  ids?: { kind: Kind; id: number }[]
  classification?: Classification
  allParked?: boolean
  allOrphaned?: boolean
  // Scopes bulk selectors to one MCM so a mass action can't touch another MCM.
  subsystemId?: number
}

const MCM_ALL = 'all' as const

// Recompute the summary from a (possibly MCM-scoped) item set so the counts,
// chips, and bulk-button labels always match exactly what's shown.
function summarize(items: QueueItem[]): QueueSummary {
  const s: QueueSummary = {
    pending: 0, parked: 0, orphaned: 0,
    byClassification: { gone_on_cloud: 0, version_conflict: 0, transient: 0, unknown: 0 },
  }
  for (const it of items) {
    if (it.status === 'orphaned') s.orphaned++
    else if (it.status === 'parked') s.parked++
    else s.pending++
    s.byClassification[it.classification]++
  }
  return s
}

const POLL_MS = 15000

// ── Classification presentation ───────────────────────────────────────────────
interface ClassMeta {
  label: string
  hint: string
  chip: string // badge classes
  Icon: React.ComponentType<{ className?: string }>
  safeToDiscard: boolean
}
const CLASS_META: Record<Classification, ClassMeta> = {
  gone_on_cloud: {
    label: 'Removed on cloud',
    hint: 'This record no longer exists on the cloud, so it can never be uploaded. Safe to discard.',
    chip: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    Icon: CloudOff,
    safeToDiscard: true,
  },
  version_conflict: {
    label: 'Newer value on cloud',
    hint: 'The cloud already has a newer value for this record. Retry only if you are sure this device should overwrite it.',
    chip: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    Icon: AlertTriangle,
    safeToDiscard: false,
  },
  transient: {
    label: 'Temporary network issue',
    hint: 'A network or server hiccup. This usually clears on its own — Retry to push it now.',
    chip: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    Icon: Wifi,
    safeToDiscard: false,
  },
  unknown: {
    label: 'Needs review',
    hint: 'The tool could not classify why this row is stuck. Try Retry; if it stays, discarding is safe (your data stays on this device).',
    chip: 'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-400',
    Icon: HelpCircle,
    safeToDiscard: false,
  },
}

const KIND_LABEL: Record<Kind, string> = {
  io: 'I/O result',
  l2: 'Functional Validation',
  blocker: 'VFD blocker',
}

function formatAge(mins: number | null): string {
  if (mins == null) return '—'
  if (mins < 1) return 'just now'
  if (mins < 60) return `${Math.round(mins)}m`
  const h = mins / 60
  if (h < 24) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

type Tab = 'parked' | 'orphaned' | 'pending' | 'all' | 'compare'

// ── Confirm dialog state ──────────────────────────────────────────────────────
interface ConfirmState {
  title: string
  body: string
  confirmLabel: string
  destructive?: boolean
  run: () => Promise<void>
}

export default function SyncPage() {
  const [data, setData] = useState<QueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<Tab>('parked')
  const [mcmFilter, setMcmFilter] = useState<number | typeof MCM_ALL>(MCM_ALL)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [reconciling, setReconciling] = useState(false)

  const rowKey = (i: { kind: Kind; id: number }) => `${i.kind}:${i.id}`

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      const r = await authFetch('/api/sync/queue?status=all')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = (await r.json()) as QueueResponse
      setData(json)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      if (manual) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(() => load(), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  // "Sync now": on-demand orphan reconcile. Re-queues local results/comments the
  // cloud is missing but that have no queue row — the exact case the pull guard
  // warns about ("N results the cloud does not have") but that the Sync Center
  // otherwise can't act on (it only shows queue rows). Best-effort, never
  // destructive. Results the cloud permanently rejected get tombstoned by the
  // push loop and stop warning; the rest get pushed.
  const handleReconcile = useCallback(async () => {
    setReconciling(true)
    try {
      const r = await authFetch('/api/cloud/reconcile', { method: 'POST' })
      const json = (await r.json().catch(() => ({}))) as { success?: boolean; enqueued?: number; warning?: string; error?: string }
      if (!r.ok || json.success === false) throw new Error(json.error || `HTTP ${r.status}`)
      const n = json.enqueued ?? 0
      toast({
        title: n > 0 ? `Re-queued ${n} unsynced item(s) for upload` : 'Nothing to re-sync',
        description: n > 0
          ? 'Local work the cloud was missing is now uploading. Items the cloud has permanently removed are marked so they stop warning.'
          : json.warning || 'Everything on this device is already on the cloud (or queued).',
      })
      await load(true)
    } catch (e) {
      toast({ variant: 'destructive', title: 'Sync now failed', description: e instanceof Error ? e.message : String(e) })
    } finally {
      setReconciling(false)
    }
  }, [load])

  const allItems = data?.items ?? []

  // Distinct MCMs present in the queue, for the per-MCM filter dropdown.
  const mcmOptions = useMemo(() => {
    const map = new Map<number, string>()
    for (const it of allItems) {
      if (it.subsystemId != null) map.set(it.subsystemId, it.mcm || `MCM ${it.subsystemId}`)
    }
    return Array.from(map.entries())
      .map(([subsystemId, label]) => ({ subsystemId, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  }, [allItems])

  // If the selected MCM drains to empty and disappears, fall back to All.
  useEffect(() => {
    if (mcmFilter !== MCM_ALL && !mcmOptions.some((o) => o.subsystemId === mcmFilter)) {
      setMcmFilter(MCM_ALL)
    }
  }, [mcmOptions, mcmFilter])

  // The MCM-scoped view: everything below (summary, tabs, bulk actions) operates
  // on this set, so an operator filtered to one MCM sees + acts on ONLY that MCM.
  const items = useMemo(
    () => (mcmFilter === MCM_ALL ? allItems : allItems.filter((i) => i.subsystemId === mcmFilter)),
    [allItems, mcmFilter],
  )
  const summary = useMemo(() => summarize(items), [items])
  // subsystemId sent with bulk actions so they resolve server-side to this MCM only.
  const scopeId = mcmFilter === MCM_ALL ? undefined : mcmFilter

  const visible = useMemo(() => {
    if (tab === 'parked') return items.filter((i) => i.status === 'parked')
    if (tab === 'orphaned') return items.filter((i) => i.status === 'orphaned')
    if (tab === 'pending') return items.filter((i) => i.status === 'pending')
    return items
  }, [items, tab])

  // Orphaned rows grouped by device (title = "DeviceName · Mcm" for L2, IO name
  // otherwise) — the "Removed on cloud" surface.
  const orphanedGroups = useMemo(() => {
    const groups = new Map<string, QueueItem[]>()
    for (const it of items) {
      if (it.status !== 'orphaned') continue
      const arr = groups.get(it.title) ?? []
      arr.push(it)
      groups.set(it.title, arr)
    }
    return Array.from(groups.entries())
  }, [items])

  // ── Action runner ───────────────────────────────────────────────────────────
  const postAction = useCallback(async (body: ActionBody): Promise<{ affected: number; message?: string; backup?: string; discardLog?: string }> => {
    const r = await authFetch('/api/sync/queue/actions', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      let msg = `HTTP ${r.status}`
      try { const j = await r.json(); if (j?.error) msg = j.error } catch { /* ignore */ }
      throw new Error(msg)
    }
    return (await r.json()) as { affected: number; message?: string; backup?: string; discardLog?: string }
  }, [])

  const rowAction = useCallback(async (item: QueueItem, action: 'retry' | 'discard') => {
    const key = rowKey(item)
    setBusyKeys((s) => new Set(s).add(key))
    try {
      const res = await postAction({ action, ids: [{ kind: item.kind, id: item.id }] })
      const discardNote = res.discardLog ? ` A record was saved to backups/${res.discardLog}.` : ''
      toast({
        title: action === 'retry' ? 'Retry queued' : 'Row discarded',
        description: (res.message ?? (action === 'retry'
          ? 'The tool will try to upload this row again.'
          : 'Stopped uploading this row. Your data is still saved on this device.')) + (action === 'discard' ? discardNote : ''),
      })
      await load()
    } catch (e) {
      toast({
        variant: 'destructive',
        title: action === 'retry' ? 'Retry failed' : 'Discard failed',
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusyKeys((s) => { const n = new Set(s); n.delete(key); return n })
    }
  }, [postAction, load])

  const bulkAction = useCallback(async (label: string, body: ActionBody) => {
    setBulkBusy(label)
    try {
      const res = await postAction(body)
      const base = res.message ?? `${res.affected} row${res.affected === 1 ? '' : 's'} ${body.action === 'retry' ? 'queued for retry' : 'discarded'}.`
      // Surface both artifacts: the .db backup (full restore point) and the
      // readable .txt record of exactly which rows were cleared.
      const artifacts = [
        res.backup ? `DB backup: ${res.backup}` : null,
        res.discardLog ? `record: backups/${res.discardLog}` : null,
      ].filter(Boolean).join(' · ')
      toast({
        title: 'Done',
        description: artifacts ? `${base} (${artifacts})` : base,
      })
      await load()
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'Action failed',
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBulkBusy(null)
    }
  }, [postAction, load])

  // discard flows route through the confirm dialog (reiterating data safety)
  const askDiscardRow = (item: QueueItem) => {
    setConfirm({
      title: 'Discard this row?',
      body: `This only removes "${item.title}" from the cloud upload queue. Your entry stays saved on this device and visible in the grid — nothing is deleted.`,
      confirmLabel: 'Discard row',
      destructive: true,
      run: () => rowAction(item, 'discard'),
    })
  }
  const askDiscardGone = () => {
    const n = summary?.byClassification.gone_on_cloud ?? 0
    setConfirm({
      title: `Discard ${n} "removed on cloud" row${n === 1 ? '' : 's'}?`,
      body: 'These records no longer exist on the cloud, so they can never upload. Discarding clears them from the queue only — nothing on this device is deleted.',
      confirmLabel: 'Discard them',
      destructive: true,
      run: () => bulkAction('discard-gone', { action: 'discard', classification: 'gone_on_cloud', subsystemId: scopeId }),
    })
  }
  const askDiscardAllParked = () => {
    const n = summary?.parked ?? 0
    setConfirm({
      title: `Discard all ${n} parked row${n === 1 ? '' : 's'}?`,
      body: 'This clears every stuck row from the cloud upload queue. Your entries remain saved on this device and shown in the grid — this never deletes your data.',
      confirmLabel: 'Discard all parked',
      destructive: true,
      run: () => bulkAction('discard-all-parked', { action: 'discard', allParked: true, subsystemId: scopeId }),
    })
  }
  const askDiscardAllOrphaned = () => {
    const n = summary?.orphaned ?? 0
    setConfirm({
      title: `Discard ${n} "removed on cloud" row${n === 1 ? '' : 's'}?`,
      body: 'These devices/records were removed on the cloud. Each row auto-restores if the device comes back — discarding just clears them from the queue now. Your entries stay saved on this device; nothing is deleted.',
      confirmLabel: 'Discard removed-on-cloud',
      destructive: true,
      run: () => bulkAction('discard-all-orphaned', { action: 'discard', allOrphaned: true, subsystemId: scopeId }),
    })
  }

  const runConfirm = async () => {
    if (!confirm) return
    setConfirmBusy(true)
    try {
      await confirm.run()
      setConfirm(null)
    } finally {
      setConfirmBusy(false)
    }
  }

  const parked = summary?.parked ?? 0
  const pending = summary?.pending ?? 0
  const orphaned = summary?.orphaned ?? 0

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* ───────── Header ───────── */}
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center gap-3 sm:gap-4">
          <Button asChild size="icon" variant="ghost" title="Back to Central Control">
            <Link to="/mcm"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <AutstandLogo className="h-5 sm:h-6 shrink-0 hidden sm:block" />
          <div className="h-6 w-px bg-border hidden sm:block" />
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight leading-none flex items-center gap-2">
              <CloudUpload className="h-4 w-4 text-primary" />Sync Center
            </h1>
            <p className="text-[11px] text-muted-foreground mt-1">
              {loading ? 'Loading queue…'
                : parked > 0 ? `${parked} row${parked === 1 ? '' : 's'} need attention`
                : pending > 0 ? `${pending} waiting to sync`
                : 'Everything is synced'}
            </p>
          </div>
          <div className="flex-1" />
          {mcmOptions.length > 0 && (
            <select
              value={mcmFilter === MCM_ALL ? 'all' : String(mcmFilter)}
              onChange={(e) => setMcmFilter(e.target.value === 'all' ? MCM_ALL : Number(e.target.value))}
              title="Show and act on only one MCM's queue"
              className="h-9 rounded-md border border-border bg-background px-2 text-sm max-w-[150px] font-medium"
            >
              <option value="all">All MCMs</option>
              {mcmOptions.map((o) => (
                <option key={o.subsystemId} value={o.subsystemId}>{o.label}</option>
              ))}
            </select>
          )}
          <Button
            onClick={handleReconcile}
            disabled={reconciling}
            size="sm"
            className="gap-1.5"
            title="Push any local results/comments the cloud is missing — including ones with no queue row (what the pull warns about)"
          >
            <CloudUpload className={cn('h-4 w-4', reconciling && 'animate-pulse')} />
            <span className="hidden sm:inline">{reconciling ? 'Syncing…' : 'Sync now'}</span>
          </Button>
          <Button onClick={() => load(true)} disabled={refreshing} size="sm" variant="outline" className="gap-1.5">
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-5 space-y-5">
        {/* ───────── Reassurance banner ───────── */}
        <div className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
          <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-emerald-700 dark:text-emerald-300">Your data is safe on this device.</p>
            <p className="text-muted-foreground mt-0.5">
              Your entries are saved on this device and shown in the grid. These rows are just the cloud
              upload queue. Discarding a row only stops trying to upload it — it never deletes your data.
            </p>
          </div>
        </div>

        {/* ───────── Error state ───────── */}
        {error && !data && (
          <Card className="border-destructive/40">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <XCircle className="h-8 w-8 text-destructive" />
              <div>
                <p className="font-semibold">Could not load the sync queue</p>
                <p className="text-sm text-muted-foreground mt-1">{error}</p>
              </div>
              <Button onClick={() => load(true)} variant="outline" className="gap-1.5">
                <RefreshCw className="h-4 w-4" />Try again
              </Button>
            </CardContent>
          </Card>
        )}

        {loading && !data ? (
          <div className="grid place-items-center py-24 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mr-2" />Loading sync queue…
          </div>
        ) : data ? (
          <>
            {/* ───────── Summary strip ───────── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <SummaryCard
                tone="attention"
                active={parked > 0}
                count={parked}
                label="Needs attention"
                sub="Parked — stopped retrying"
                Icon={AlertTriangle}
              />
              <SummaryCard
                tone="pending"
                active={pending > 0}
                count={pending}
                label="Waiting to sync"
                sub="Pending — will upload automatically"
                Icon={CloudUpload}
              />
            </div>

            {/* Per-classification chips */}
            {summary && (parked > 0 || pending > 0) && (
              <div className="flex flex-wrap gap-2">
                {(Object.keys(CLASS_META) as Classification[]).map((c) => {
                  const n = summary.byClassification[c] ?? 0
                  const m = CLASS_META[c]
                  return (
                    <span
                      key={c}
                      title={m.hint}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
                        n > 0 ? m.chip : 'border-border bg-muted/40 text-muted-foreground',
                      )}
                    >
                      <m.Icon className="h-3.5 w-3.5" />
                      {m.label}
                      <span className="tabular-nums opacity-80">{n}</span>
                    </span>
                  )
                })}
              </div>
            )}

            {/* ───────── Bulk action bar ───────── */}
            {parked > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1">
                  Bulk fixes
                  {scopeId != null
                    ? <span className="ml-1 normal-case text-primary">· {mcmOptions.find((o) => o.subsystemId === scopeId)?.label ?? `MCM ${scopeId}`} only</span>
                    : mcmOptions.length > 1 && <span className="ml-1 normal-case text-amber-600 dark:text-amber-400">· all MCMs</span>}
                </span>
                <Button
                  size="sm" variant="outline" className="gap-1.5"
                  disabled={!!bulkBusy}
                  onClick={() => bulkAction('retry-all-parked', { action: 'retry', allParked: true, subsystemId: scopeId })}
                >
                  {bulkBusy === 'retry-all-parked' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                  Retry all parked
                </Button>
                {(summary?.byClassification.gone_on_cloud ?? 0) > 0 && (
                  <Button
                    size="sm" variant="outline"
                    className="gap-1.5 border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                    disabled={!!bulkBusy}
                    onClick={askDiscardGone}
                  >
                    {bulkBusy === 'discard-gone' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudOff className="h-3.5 w-3.5" />}
                    Discard all “removed on cloud” ({summary?.byClassification.gone_on_cloud})
                  </Button>
                )}
                <div className="flex-1" />
                <Button
                  size="sm" variant="ghost"
                  className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={!!bulkBusy}
                  onClick={askDiscardAllParked}
                >
                  {bulkBusy === 'discard-all-parked' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Discard all parked
                </Button>
              </div>
            )}

            {/* ───────── Tabs ───────── */}
            <div className="flex items-center gap-1 border-b border-border">
              <TabButton active={tab === 'parked'} onClick={() => setTab('parked')} label="Needs Attention" count={parked} tone="attention" />
              <TabButton active={tab === 'orphaned'} onClick={() => setTab('orphaned')} label="Removed on cloud" count={orphaned} tone="removed" />
              <TabButton active={tab === 'pending'} onClick={() => setTab('pending')} label="Pending" count={pending} tone="pending" />
              <TabButton active={tab === 'all'} onClick={() => setTab('all')} label="All" count={items.length} tone="neutral" />
              <TabButton active={tab === 'compare'} onClick={() => setTab('compare')} label="Compare with cloud" count={undefined} tone="neutral" />
            </div>

            {/* ───────── Compare with cloud (version-aware diff) ───────── */}
            {tab === 'compare' ? (
              <SyncCompare subsystemId={mcmFilter === MCM_ALL ? 'all' : mcmFilter} />
            ) : /* ───────── Removed-on-cloud (orphaned) section ───────── */
            tab === 'orphaned' ? (
              orphaned === 0 ? (
                <div className="grid place-items-center py-16 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-3" />
                  <p className="font-semibold">Nothing removed on cloud</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    No queued work is waiting on a device that was deleted from the cloud.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
                    <CloudOff className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
                    <div className="text-sm min-w-0 flex-1">
                      <p className="font-semibold text-emerald-700 dark:text-emerald-300">Removed on cloud</p>
                      <p className="text-muted-foreground mt-0.5">
                        These devices/records were removed on the cloud — auto-restores if the device comes back;
                        discard to clear. Your entries stay saved on this device; nothing here is deleted.
                      </p>
                    </div>
                    <Button
                      size="sm" variant="outline"
                      className="gap-1.5 border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
                      disabled={!!bulkBusy}
                      onClick={askDiscardAllOrphaned}
                    >
                      {bulkBusy === 'discard-all-orphaned' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      Discard all ({orphaned})
                    </Button>
                  </div>

                  {orphanedGroups.map(([title, rows]) => (
                    <div key={title} className="overflow-hidden rounded-lg border border-emerald-500/25">
                      <div className="flex items-center gap-2 bg-emerald-500/5 px-3 py-2 border-b border-emerald-500/20">
                        <CloudOff className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        <span className="font-semibold text-sm truncate">{title}</span>
                        <span className="text-[11px] text-muted-foreground">{rows.length} queued {rows.length === 1 ? 'value' : 'values'}</span>
                      </div>
                      <div className="divide-y divide-border">
                        {rows.map((item) => {
                          const key = rowKey(item)
                          const busy = busyKeys.has(key)
                          return (
                            <div key={key} className={cn('flex items-center gap-3 px-3 py-2.5', busy && 'opacity-60')}>
                              <div className="min-w-0 flex-1">
                                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{KIND_LABEL[item.kind]}</div>
                                <div className="text-sm truncate">
                                  {item.subtitle && <span className="text-muted-foreground">{item.subtitle}: </span>}
                                  {item.value ? <span className="font-mono">{item.value}</span> : <span className="text-muted-foreground">—</span>}
                                </div>
                              </div>
                              <span className="hidden sm:inline text-[11px] text-muted-foreground whitespace-nowrap">{formatAge(item.ageMinutes)}</span>
                              <Button
                                size="sm" variant="ghost"
                                className="gap-1 h-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                disabled={busy}
                                onClick={() => askDiscardRow(item)}
                                title="Stop tracking this removed record (your data stays on this device)"
                              >
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                <span className="hidden sm:inline">Discard</span>
                              </Button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : visible.length === 0 ? (
              <div className="grid place-items-center py-16 text-center">
                <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-3" />
                <p className="font-semibold">
                  {tab === 'parked' ? 'Nothing needs attention' : tab === 'pending' ? 'Nothing waiting to sync' : 'The sync queue is empty'}
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  All your work is uploaded to the cloud, or safely queued and moving.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr className="[&>th]:px-3 [&>th]:py-2.5 [&>th]:text-left [&>th]:font-semibold [&>th]:whitespace-nowrap">
                      <th className="w-8" />
                      <th>Item</th>
                      <th className="hidden md:table-cell">Value</th>
                      <th>Status</th>
                      <th className="hidden sm:table-cell">Why it’s stuck</th>
                      <th className="hidden lg:table-cell">Age</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((item) => {
                      const key = rowKey(item)
                      const m = CLASS_META[item.classification]
                      const isOpen = expanded.has(key)
                      const busy = busyKeys.has(key)
                      const hasDetail = !!item.lastError || !!item.subtitle
                      return (
                        <FragmentRow key={key}>
                          <tr className={cn('border-t border-border align-top hover:bg-muted/30', busy && 'opacity-60')}>
                            <td className="px-2 py-3">
                              {hasDetail && (
                                <button
                                  onClick={() => setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })}
                                  className="text-muted-foreground hover:text-foreground p-1"
                                  title={isOpen ? 'Hide details' : 'Show details'}
                                >
                                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                </button>
                              )}
                            </td>
                            <td className="px-3 py-3">
                              <div className="font-medium leading-tight">{item.title}</div>
                              <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
                                <span className="uppercase tracking-wide">{KIND_LABEL[item.kind]}</span>
                                <span className="opacity-40">•</span>
                                <span className="font-semibold text-foreground/70">{item.mcm ?? 'Unassigned'}</span>
                                {item.subtitle && <><span className="opacity-40">•</span><span className="truncate max-w-[200px]">{item.subtitle}</span></>}
                              </div>
                            </td>
                            <td className="px-3 py-3 hidden md:table-cell">
                              {item.value ? <span className="font-mono text-xs">{item.value}</span> : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="px-3 py-3">
                              <StatusBadge status={item.status} />
                            </td>
                            <td className="px-3 py-3 hidden sm:table-cell max-w-[280px]">
                              <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold', m.chip)} title={m.hint}>
                                <m.Icon className="h-3 w-3" />{m.label}
                              </span>
                              <div className="text-[11px] text-muted-foreground mt-1 leading-snug">{item.reason}</div>
                            </td>
                            <td className="px-3 py-3 hidden lg:table-cell whitespace-nowrap text-muted-foreground">
                              <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{formatAge(item.ageMinutes)}</span>
                              {item.retryCount > 0 && <div className="text-[10px] opacity-70">{item.retryCount} tries</div>}
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex items-center justify-end gap-1.5">
                                <Button
                                  size="sm" variant="outline" className="gap-1 h-8"
                                  disabled={busy}
                                  onClick={() => rowAction(item, 'retry')}
                                  title="Try to upload this row again"
                                >
                                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                                  <span className="hidden sm:inline">Retry</span>
                                </Button>
                                <Button
                                  size="sm" variant="ghost" className="gap-1 h-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  disabled={busy}
                                  onClick={() => askDiscardRow(item)}
                                  title="Stop uploading this row (your data stays on this device)"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  <span className="hidden sm:inline">Discard</span>
                                </Button>
                              </div>
                            </td>
                          </tr>
                          {isOpen && hasDetail && (
                            <tr className="border-t border-border/50 bg-muted/20">
                              <td />
                              <td colSpan={6} className="px-3 py-3">
                                <div className="space-y-2 text-xs">
                                  {/* on small screens the classification/reason are hidden in the row — surface here */}
                                  <div className="sm:hidden">
                                    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-semibold', m.chip)}>
                                      <m.Icon className="h-3 w-3" />{m.label}
                                    </span>
                                    <div className="text-muted-foreground mt-1">{item.reason}</div>
                                  </div>
                                  <p className="text-muted-foreground flex items-start gap-1.5">
                                    <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />{m.hint}
                                  </p>
                                  {item.lastError && (
                                    <div>
                                      <div className="font-semibold text-muted-foreground uppercase tracking-wider text-[10px] mb-1">Technical detail</div>
                                      <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px] text-muted-foreground">{item.lastError}</pre>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </FragmentRow>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {error && data && (
              <p className="text-xs text-warning flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />Live refresh failed ({error}) — showing last known state.
              </p>
            )}
          </>
        ) : null}
      </main>

      {/* ───────── Confirm dialog ───────── */}
      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o && !confirmBusy) setConfirm(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-500" />{confirm?.title}
            </DialogTitle>
            <DialogDescription className="pt-1">{confirm?.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={confirmBusy}>Cancel</Button>
            <Button
              variant={confirm?.destructive ? 'destructive' : 'default'}
              onClick={runConfirm}
              disabled={confirmBusy}
              className="gap-1.5"
            >
              {confirmBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {confirm?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Small presentational helpers ──────────────────────────────────────────────
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function StatusBadge({ status }: { status: QueueStatus }) {
  if (status === 'orphaned') {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <CloudOff className="h-3 w-3" />Removed on cloud
      </Badge>
    )
  }
  if (status === 'parked') {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3" />Parked
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400">
      <CloudUpload className="h-3 w-3" />Pending
    </Badge>
  )
}

function SummaryCard({
  tone, active, count, label, sub, Icon,
}: {
  tone: 'attention' | 'pending'
  active: boolean
  count: number
  label: string
  sub: string
  Icon: React.ComponentType<{ className?: string }>
}) {
  const attention = tone === 'attention'
  return (
    <Card className={cn(
      'border',
      active && attention ? 'border-amber-500/40 bg-amber-500/5'
        : active ? 'border-sky-500/40 bg-sky-500/5'
        : 'border-border',
    )}>
      <CardContent className="flex items-center gap-4 py-5">
        <div className={cn(
          'grid place-items-center h-12 w-12 rounded-lg shrink-0',
          active && attention ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
            : active ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
            : 'bg-muted text-muted-foreground',
        )}>
          {active ? <Icon className="h-6 w-6" /> : <CheckCircle2 className="h-6 w-6 text-emerald-500" />}
        </div>
        <div>
          <div className="text-3xl font-bold tabular-nums leading-none">{count}</div>
          <div className="text-sm font-semibold mt-1">{label}</div>
          <div className="text-[11px] text-muted-foreground">{sub}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function TabButton({
  active, onClick, label, count, tone,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
  tone: 'attention' | 'removed' | 'pending' | 'neutral'
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative px-3 sm:px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2 whitespace-nowrap',
        active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      {count != null && count > 0 && (
        <span className={cn(
          'ml-2 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-bold tabular-nums',
          tone === 'attention' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
            : tone === 'removed' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            : tone === 'pending' ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
            : 'bg-muted text-muted-foreground',
        )}>
          {count}
        </span>
      )}
    </button>
  )
}
