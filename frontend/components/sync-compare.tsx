"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ToastAction } from '@/components/ui/toast'
import { authFetch } from '@/lib/api-config'
import { fetchWithTimeout, isFetchTimeoutError } from '@/lib/fetch-with-timeout'
import { toast } from '@/hooks/use-toast'
import { RefreshCw, ArrowUpToLine, CloudDownload, Ban, GitCompareArrows, AlertTriangle } from 'lucide-react'

// Mirror of lib/sync/sync-diff.ts (kept local to the component — no server import).
type DiffClass = 'local_only' | 'local_newer' | 'cloud_newer' | 'cloud_only' | 'gone_on_cloud' | 'conflict'
type DiffAction = 'push' | 'accept_cloud' | 'tombstone' | 'pull' | 'none'
interface DiffRow {
  id: number; name: string; classification: DiffClass; reason: string; action: DiffAction
  localResult: string | null; localVersion: number; localTimestamp: string | null
  cloudResult: string | null; cloudVersion: number | null
}
interface DiffSummary { total: number; inSync: number; push: number; acceptCloud: number; tombstone: number; pull: number; conflict: number }
interface PerSub { subsystemId: number; mcm: string | null; ok: boolean; error?: string; summary?: DiffSummary; rows?: DiffRow[] }
interface DiffResp { success: boolean; summary: DiffSummary; perSubsystem: PerSub[]; error?: string }

type ActionKind = 'push' | 'accept_cloud' | 'tombstone'

const CLASS_META: Record<DiffClass, { label: string; cls: string }> = {
  local_newer:   { label: 'Local newer',    cls: 'text-emerald-600 dark:text-emerald-400' },
  local_only:    { label: 'Not on cloud',   cls: 'text-emerald-600 dark:text-emerald-400' },
  cloud_newer:   { label: 'Local stale',    cls: 'text-amber-600 dark:text-amber-400' },
  gone_on_cloud: { label: 'Removed on cloud', cls: 'text-red-600 dark:text-red-400' },
  cloud_only:    { label: 'Cloud only',     cls: 'text-muted-foreground' },
  conflict:      { label: 'Conflict',       cls: 'text-red-600 dark:text-red-400' },
}

const val = (v: string | null) => (v && v.trim() ? v : '—')

// ── Pure reconcile helpers ─────────────────────────────────────────────────
// These make the ACTION path optimistic and non-blocking: instead of firing a
// mutation and then `await`-ing a full re-diff (minutes) before the UI updates,
// we edit the already-loaded model in place. Exported + unit-tested (the
// component itself isn't rendered in tests — no jsdom).

/** Unique key for a row across groups (a raw id repeats between subsystems). */
export const rowKey = (subsystemId: number, id: number) => `${subsystemId}:${id}`

type SummaryBucket = 'push' | 'acceptCloud' | 'tombstone' | 'pull' | 'conflict'

/** Which actionable summary bucket a class counts toward (mirror of sync-diff.ts). */
function bucketOf(cls: DiffClass): SummaryBucket | null {
  switch (cls) {
    case 'local_only':
    case 'local_newer':   return 'push'
    case 'cloud_newer':   return 'acceptCloud'
    case 'gone_on_cloud': return 'tombstone'
    case 'cloud_only':    return 'pull'
    case 'conflict':      return 'conflict'
    default:              return null
  }
}

// Most-actionable-first, matching the diff route's ordering so a rolled-back row
// returns to the position it was pulled from.
const RANK: Record<DiffClass, number> = {
  conflict: 0, local_newer: 1, local_only: 2, cloud_newer: 3, gone_on_cloud: 4, cloud_only: 5,
}

/** Recount a group's summary from its (post-edit) rows. `total` stays fixed — a
 *  resolved actionable row becomes in-sync, it doesn't leave the population. */
function summarize(rows: DiffRow[], total: number): DiffSummary {
  const s: DiffSummary = { total, inSync: 0, push: 0, acceptCloud: 0, tombstone: 0, pull: 0, conflict: 0 }
  for (const r of rows) { const b = bucketOf(r.classification); if (b) s[b]++ }
  s.inSync = Math.max(0, total - (s.push + s.acceptCloud + s.tombstone + s.pull + s.conflict))
  return s
}

/** Top-level summary = sum of per-subsystem summaries (exactly how the diff route
 *  builds it), so the header numbers stay honest after an optimistic edit. */
function aggregate(perSubsystem: PerSub[], fallback: DiffSummary): DiffSummary {
  const s: DiffSummary = { total: 0, inSync: 0, push: 0, acceptCloud: 0, tombstone: 0, pull: 0, conflict: 0 }
  let seen = false
  for (const p of perSubsystem) {
    if (!p.summary) continue
    seen = true
    s.total += p.summary.total; s.inSync += p.summary.inSync
    s.push += p.summary.push; s.acceptCloud += p.summary.acceptCloud
    s.tombstone += p.summary.tombstone; s.pull += p.summary.pull; s.conflict += p.summary.conflict
  }
  return seen ? s : fallback
}

/**
 * Optimistic removal: drop `ids` from `subsystemId`'s rows and recompute that
 * group's summary + the top-level summary so every visible count ticks down —
 * WITHOUT a re-diff. Returns the same reference when nothing matched (so React
 * can bail out of the render). The PerSub object is kept even when it empties,
 * so a later rollback can still find its group.
 */
export function removeRows(data: DiffResp, subsystemId: number, ids: number[]): DiffResp {
  if (ids.length === 0) return data
  const idSet = new Set(ids)
  let changed = false
  const perSubsystem = data.perSubsystem.map((p) => {
    if (p.subsystemId !== subsystemId || !p.rows) return p
    const rows = p.rows.filter((r) => !idSet.has(r.id))
    if (rows.length === p.rows.length) return p
    changed = true
    return { ...p, rows, summary: summarize(rows, p.summary?.total ?? p.rows.length) }
  })
  return changed ? { ...data, perSubsystem, summary: aggregate(perSubsystem, data.summary) } : data
}

/**
 * Rollback (inverse of removeRows): put `rows` back into `subsystemId`, skipping
 * ids already present so a double-apply can't duplicate, re-sorted to their
 * original rank, and recompute summaries. Written as a functional patch of the
 * CURRENT model (not a whole-snapshot restore) so it composes with other rows
 * removed/rolled-back concurrently instead of clobbering their state.
 */
export function reinsertRows(data: DiffResp, subsystemId: number, rows: DiffRow[]): DiffResp {
  if (rows.length === 0) return data
  let changed = false
  const perSubsystem = data.perSubsystem.map((p) => {
    if (p.subsystemId !== subsystemId) return p
    const existing = p.rows ?? []
    const have = new Set(existing.map((r) => r.id))
    const add = rows.filter((r) => !have.has(r.id))
    if (add.length === 0) return p
    changed = true
    const merged = [...existing, ...add].sort((a, b) => RANK[a.classification] - RANK[b.classification] || a.id - b.id)
    return { ...p, rows: merged, summary: summarize(merged, p.summary?.total ?? merged.length) }
  })
  return changed ? { ...data, perSubsystem, summary: aggregate(perSubsystem, data.summary) } : data
}

/** The live rows for a sub & id set — the snapshot a rollback re-inserts. */
function extractRows(data: DiffResp | null, subsystemId: number, ids: number[]): DiffRow[] {
  if (!data) return []
  const idSet = new Set(ids)
  const p = data.perSubsystem.find((x) => x.subsystemId === subsystemId)
  return (p?.rows ?? []).filter((r) => idSet.has(r.id))
}

const idsOf = (rows: DiffRow[], ...cls: DiffClass[]) => rows.filter(r => cls.includes(r.classification)).map(r => r.id)

export function SyncCompare({ subsystemId }: { subsystemId: number | 'all' }) {
  const [data, setData] = useState<DiffResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Per-row interaction state replaces the old single global `busy` lock (which
  // disabled EVERY button and, worse, `await load()`-ed a full re-diff — minutes
  // — before releasing). `pending` = rows with an action in flight; `failed` =
  // last error per row. Keyed by rowKey so acting on one row never touches another.
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [failed, setFailed] = useState<Map<string, string>>(() => new Map())

  // Latest model, read (not subscribed) by act() so its identity stays stable and
  // each action snapshots its rows from current truth for a precise rollback.
  const dataRef = useRef<DiffResp | null>(null)
  useEffect(() => { dataRef.current = data }, [data])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = subsystemId === 'all' ? '' : `?subsystemId=${subsystemId}`
      // A bare fetch on a dead link hangs forever (no response, no error), so the
      // finally below never runs and the spinner never stops. Bound it: on
      // timeout the request aborts and we show a clear message instead.
      const r = await fetchWithTimeout((signal) => authFetch(`/api/sync/diff${qs}`, { signal }), 15000)
      const j = (await r.json()) as DiffResp
      if (!r.ok || j.success === false) throw new Error(j.error || `HTTP ${r.status}`)
      setData(j); setError(null)
      // A fresh diff is the new truth — drop per-row in-flight/error marks that
      // referred to the previous model so stale spinners/badges don't linger.
      setPending(new Set()); setFailed(new Map())
    } catch (e) {
      setError(isFetchTimeoutError(e)
        ? "Couldn't reach the cloud to compare — check the connection."
        : (e instanceof Error ? e.message : String(e)))
    } finally { setLoading(false) }
  }, [subsystemId])

  useEffect(() => { load() }, [load])

  // Stable ref to the latest act() so the toast's Retry can re-run it without
  // capturing a stale closure or forcing act into its own dependency list.
  const actRef = useRef<((action: ActionKind, sub: number, ids: number[], label: string) => void) | null>(null)

  const act = useCallback((action: ActionKind, sub: number, ids: number[], label: string) => {
    if (ids.length === 0) return
    const keys = ids.map((id) => rowKey(sub, id))
    // Snapshot ONLY the acted rows (not the whole model): a rollback re-inserts
    // exactly these into whatever the model looks like later, composing with
    // other concurrent actions instead of resurrecting their removed rows.
    const snapshot = extractRows(dataRef.current, sub, ids)

    setPending((prev) => { const n = new Set(prev); keys.forEach((k) => n.add(k)); return n })
    setFailed((prev) => { if (!keys.some((k) => prev.has(k))) return prev; const n = new Map(prev); keys.forEach((k) => n.delete(k)); return n })
    // Optimistic: the rows vanish and the group + header counts tick down NOW.
    setData((prev) => (prev ? removeRows(prev, sub, ids) : prev))

    void (async () => {
      try {
        const r = await fetchWithTimeout((signal) => authFetch('/api/sync/diff/actions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, subsystemId: sub, ids }), signal,
        }), 15000)
        const j = (await r.json()) as { success?: boolean; affected?: number; message?: string; error?: string }
        if (!r.ok || j.success === false) throw new Error(j.message || j.error || `HTTP ${r.status}`)
        toast({ title: label, description: j.message })
        // Success: the optimistic removal is authoritative — NO re-diff. Just
        // clear the in-flight marks for these rows.
        setPending((prev) => { const n = new Set(prev); keys.forEach((k) => n.delete(k)); return n })
      } catch (e) {
        const msg = isFetchTimeoutError(e)
          ? "Couldn't reach the cloud — check the connection."
          : (e instanceof Error ? e.message : String(e))
        // Roll the acted rows back into the CURRENT model and mark them failed.
        setData((prev) => (prev ? reinsertRows(prev, sub, snapshot) : prev))
        setFailed((prev) => { const n = new Map(prev); keys.forEach((k) => n.set(k, msg)); return n })
        setPending((prev) => { const n = new Set(prev); keys.forEach((k) => n.delete(k)); return n })
        toast({
          variant: 'destructive', title: `${label} failed`, description: msg,
          action: <ToastAction altText="Retry" onClick={() => actRef.current?.(action, sub, ids, label)}>Retry</ToastAction>,
        })
      }
    })()
  }, [])

  useEffect(() => { actRef.current = act }, [act])

  if (loading && !data) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground gap-2"><RefreshCw className="h-4 w-4 animate-spin" />Comparing with cloud…</div>
  }
  if (error) {
    return (
      <Card className="border-destructive/40"><CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertTriangle className="h-7 w-7 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button onClick={load} variant="outline" size="sm" className="gap-1.5"><RefreshCw className="h-4 w-4" />Retry</Button>
      </CardContent></Card>
    )
  }

  const s = data?.summary
  const subs = (data?.perSubsystem ?? []).filter(p => p.ok && (p.rows?.length ?? 0) > 0)
  const allSynced = subs.length === 0 && !data?.perSubsystem.some(p => !p.ok)

  return (
    <div className="space-y-4">
      {/* Summary + explanation */}
      <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <GitCompareArrows className="h-5 w-5 shrink-0 text-primary mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">Compare with cloud</p>
          <p className="text-muted-foreground mt-0.5">
            This checks every local result against the cloud, version by version.
            {s && (
              <> <b className="text-foreground">{s.push}</b> to push (yours is newer/only local),
              <> <b className="text-foreground">{s.acceptCloud}</b> stale (cloud is newer),</>
              <> <b className="text-foreground">{s.tombstone}</b> removed on cloud,</>
              <> <b className="text-foreground">{s.conflict}</b> conflict.</></>
            )}
          </p>
        </div>
        <div className="flex-1" />
        <Button onClick={load} disabled={loading} size="sm" variant="outline" className="gap-1.5">
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /><span className="hidden sm:inline">Recompare</span>
        </Button>
      </div>

      {allSynced && (
        <Card><CardContent className="py-12 text-center text-muted-foreground">
          Everything on this device matches the cloud. Nothing to reconcile.
        </CardContent></Card>
      )}

      {data?.perSubsystem.filter(p => !p.ok).map(p => (
        <div key={`err-${p.subsystemId}`} className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-300">
          {p.mcm ? `${p.mcm} (${p.subsystemId})` : `Subsystem ${p.subsystemId}`}: {p.error}
        </div>
      ))}

      {subs.map(p => {
        const rows = p.rows!
        const pushIds = idsOf(rows, 'local_only', 'local_newer')
        const staleIds = idsOf(rows, 'cloud_newer')
        const goneIds = idsOf(rows, 'gone_on_cloud')
        const label = p.mcm ? `${p.mcm}` : `Subsystem ${p.subsystemId}`
        // A group button disables only while ITS OWN ids are in flight, never the
        // whole panel. (Optimistic removal usually empties the set first, so the
        // button unmounts — this guards the brief window and the >200 tail.)
        const groupBusy = (list: number[]) => list.some((id) => pending.has(rowKey(p.subsystemId, id)))
        return (
          <Card key={p.subsystemId}>
            <CardContent className="p-0">
              {/* per-MCM header + bulk actions */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                <span className="font-semibold text-sm">{label}</span>
                <span className="text-xs text-muted-foreground">{rows.length} to reconcile</span>
                <div className="flex-1" />
                {pushIds.length > 0 && (
                  <Button size="sm" className="h-7 gap-1.5" disabled={groupBusy(pushIds)} onClick={() => act('push', p.subsystemId, pushIds, `Pushed ${pushIds.length}`)}>
                    <ArrowUpToLine className="h-3.5 w-3.5" />Push {pushIds.length} newer
                  </Button>
                )}
                {staleIds.length > 0 && (
                  <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={groupBusy(staleIds)} onClick={() => act('accept_cloud', p.subsystemId, staleIds, `Accepted cloud for ${staleIds.length}`)}>
                    <CloudDownload className="h-3.5 w-3.5" />Accept cloud for {staleIds.length} stale
                  </Button>
                )}
                {goneIds.length > 0 && (
                  <Button size="sm" variant="outline" className="h-7 gap-1.5 text-red-600 dark:text-red-400" disabled={groupBusy(goneIds)} onClick={() => act('tombstone', p.subsystemId, goneIds, `Accepted ${goneIds.length} removed`)}>
                    <Ban className="h-3.5 w-3.5" />Accept {goneIds.length} removed
                  </Button>
                )}
              </div>
              {/* rows */}
              <div className="divide-y divide-border/60">
                {rows.slice(0, 200).map(row => {
                  const m = CLASS_META[row.classification]
                  const key = rowKey(p.subsystemId, row.id)
                  const isPending = pending.has(key)
                  const failMsg = failed.get(key)
                  return (
                    <div key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                      <span className="font-mono text-xs truncate max-w-[240px]" title={row.name}>{row.name}</span>
                      <span className={cn('text-[11px] font-semibold uppercase tracking-wide', m.cls)}>{m.label}</span>
                      <span className="text-xs text-muted-foreground">
                        local <b className="text-foreground">{val(row.localResult)}</b> v{row.localVersion}
                        {' · '}cloud <b className="text-foreground">{val(row.cloudResult)}</b>{row.cloudVersion != null ? ` v${row.cloudVersion}` : ''}
                      </span>
                      <div className="flex-1" />
                      {failMsg && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400" title={failMsg}>
                          <AlertTriangle className="h-3 w-3 shrink-0" /><span className="max-w-[200px] truncate">{failMsg}</span>
                        </span>
                      )}
                      {row.action === 'push' && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1" disabled={isPending} onClick={() => act('push', p.subsystemId, [row.id], failMsg ? 'Retried push' : 'Pushed')}>
                          {isPending ? <RefreshCw className="h-3 w-3 animate-spin" /> : <ArrowUpToLine className="h-3 w-3" />}{failMsg ? 'Retry' : 'Push'}
                        </Button>
                      )}
                      {row.action === 'accept_cloud' && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1" disabled={isPending} onClick={() => act('accept_cloud', p.subsystemId, [row.id], failMsg ? 'Retried accept' : 'Accepted cloud')}>
                          {isPending ? <RefreshCw className="h-3 w-3 animate-spin" /> : <CloudDownload className="h-3 w-3" />}{failMsg ? 'Retry' : 'Accept cloud'}
                        </Button>
                      )}
                      {row.action === 'tombstone' && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1 text-red-600 dark:text-red-400" disabled={isPending} onClick={() => act('tombstone', p.subsystemId, [row.id], failMsg ? 'Retried accept' : 'Accepted removed')}>
                          {isPending ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}{failMsg ? 'Retry' : 'Accept'}
                        </Button>
                      )}
                    </div>
                  )
                })}
                {rows.length > 200 && (
                  <div className="px-4 py-2 text-xs text-muted-foreground">Showing first 200 of {rows.length}. Use the bulk actions above to clear the rest.</div>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
