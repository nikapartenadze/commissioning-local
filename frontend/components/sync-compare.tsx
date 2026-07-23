"use client"

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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

const CLASS_META: Record<DiffClass, { label: string; cls: string }> = {
  local_newer:   { label: 'Local newer',    cls: 'text-emerald-600 dark:text-emerald-400' },
  local_only:    { label: 'Not on cloud',   cls: 'text-emerald-600 dark:text-emerald-400' },
  cloud_newer:   { label: 'Local stale',    cls: 'text-amber-600 dark:text-amber-400' },
  gone_on_cloud: { label: 'Removed on cloud', cls: 'text-red-600 dark:text-red-400' },
  cloud_only:    { label: 'Cloud only',     cls: 'text-muted-foreground' },
  conflict:      { label: 'Conflict',       cls: 'text-red-600 dark:text-red-400' },
}

const val = (v: string | null) => (v && v.trim() ? v : '—')

export function SyncCompare({ subsystemId }: { subsystemId: number | 'all' }) {
  const [data, setData] = useState<DiffResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

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
    } catch (e) {
      setError(isFetchTimeoutError(e)
        ? "Couldn't reach the cloud to compare — check the connection."
        : (e instanceof Error ? e.message : String(e)))
    } finally { setLoading(false) }
  }, [subsystemId])

  useEffect(() => { load() }, [load])

  const act = useCallback(async (action: 'push' | 'accept_cloud' | 'tombstone', sub: number, ids: number[], label: string) => {
    if (ids.length === 0) return
    setBusy(`${action}:${sub}`)
    try {
      const r = await fetchWithTimeout((signal) => authFetch('/api/sync/diff/actions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, subsystemId: sub, ids }), signal,
      }), 15000)
      const j = (await r.json()) as { success?: boolean; affected?: number; message?: string; error?: string }
      if (!r.ok || j.success === false) throw new Error(j.error || `HTTP ${r.status}`)
      toast({ title: label, description: j.message })
      await load()
    } catch (e) {
      toast({ variant: 'destructive', title: `${label} failed`, description: isFetchTimeoutError(e)
        ? "Couldn't reach the cloud — check the connection."
        : (e instanceof Error ? e.message : String(e)) })
    } finally { setBusy(null) }
  }, [load])

  const idsOf = (rows: DiffRow[], ...cls: DiffClass[]) => rows.filter(r => cls.includes(r.classification)).map(r => r.id)

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
        return (
          <Card key={p.subsystemId}>
            <CardContent className="p-0">
              {/* per-MCM header + bulk actions */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                <span className="font-semibold text-sm">{label}</span>
                <span className="text-xs text-muted-foreground">{rows.length} to reconcile</span>
                <div className="flex-1" />
                {pushIds.length > 0 && (
                  <Button size="sm" className="h-7 gap-1.5" disabled={busy != null} onClick={() => act('push', p.subsystemId, pushIds, `Pushed ${pushIds.length}`)}>
                    <ArrowUpToLine className="h-3.5 w-3.5" />Push {pushIds.length} newer
                  </Button>
                )}
                {staleIds.length > 0 && (
                  <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={busy != null} onClick={() => act('accept_cloud', p.subsystemId, staleIds, `Accepted cloud for ${staleIds.length}`)}>
                    <CloudDownload className="h-3.5 w-3.5" />Accept cloud for {staleIds.length} stale
                  </Button>
                )}
                {goneIds.length > 0 && (
                  <Button size="sm" variant="outline" className="h-7 gap-1.5 text-red-600 dark:text-red-400" disabled={busy != null} onClick={() => act('tombstone', p.subsystemId, goneIds, `Accepted ${goneIds.length} removed`)}>
                    <Ban className="h-3.5 w-3.5" />Accept {goneIds.length} removed
                  </Button>
                )}
              </div>
              {/* rows */}
              <div className="divide-y divide-border/60">
                {rows.slice(0, 200).map(row => {
                  const m = CLASS_META[row.classification]
                  return (
                    <div key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                      <span className="font-mono text-xs truncate max-w-[240px]" title={row.name}>{row.name}</span>
                      <span className={cn('text-[11px] font-semibold uppercase tracking-wide', m.cls)}>{m.label}</span>
                      <span className="text-xs text-muted-foreground">
                        local <b className="text-foreground">{val(row.localResult)}</b> v{row.localVersion}
                        {' · '}cloud <b className="text-foreground">{val(row.cloudResult)}</b>{row.cloudVersion != null ? ` v${row.cloudVersion}` : ''}
                      </span>
                      <div className="flex-1" />
                      {row.action === 'push' && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1" disabled={busy != null} onClick={() => act('push', p.subsystemId, [row.id], 'Pushed')}>
                          <ArrowUpToLine className="h-3 w-3" />Push
                        </Button>
                      )}
                      {row.action === 'accept_cloud' && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1" disabled={busy != null} onClick={() => act('accept_cloud', p.subsystemId, [row.id], 'Accepted cloud')}>
                          <CloudDownload className="h-3 w-3" />Accept cloud
                        </Button>
                      )}
                      {row.action === 'tombstone' && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs gap-1 text-red-600 dark:text-red-400" disabled={busy != null} onClick={() => act('tombstone', p.subsystemId, [row.id], 'Accepted removed')}>
                          <Ban className="h-3 w-3" />Accept
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
