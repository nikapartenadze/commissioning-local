import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, CheckCircle2, XCircle, UploadCloud, AlertTriangle, Cloud } from 'lucide-react'
import { apiCall } from '@/lib/api-config'
import { cn } from '@/lib/utils'
import { commFrom } from '@/lib/logix-comm-path'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useConfirm } from './use-confirm'

export interface BatchUploadTarget { subsystemId: string; name: string; ip?: string; path?: string; connected?: boolean }

interface BatchItem {
  subsystemId: string; name: string; comm: string; out?: string
  status: 'pending' | 'running' | 'done' | 'error'; percent: number; statusText: string; error?: string
  sharepoint?: { status: 'pending' | 'uploading' | 'done' | 'error' | 'skipped'; webUrl?: string; error?: string }
}
interface BatchJob {
  id: string; status: 'running' | 'done' | 'error'; percent: number; statusText: string
  items?: BatchItem[]; error?: string
}

const sectionLbl = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'

export function BatchUploadDialog({ mcms, open, onOpenChange }: {
  mcms: BatchUploadTarget[]; open: boolean; onOpenChange: (v: boolean) => void
}) {
  const selectable = useMemo(() => mcms.map((m) => ({ ...m, comm: commFrom(m.ip || '', m.path || '1,0'), hasIp: !!(m.ip && m.ip.trim()), connected: !!m.connected })), [mcms])
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [starting, setStarting] = useState(false)
  const [job, setJob] = useState<BatchJob | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sp, setSp] = useState<{ configured: boolean; siteUrl?: string } | null>(null)
  const [pushToSharePoint, setPushToSharePoint] = useState(false)
  const pollRef = useRef<number | null>(null)
  const { confirm, confirmModal } = useConfirm()

  // Default-check the CONNECTED controllers whenever the dialog (re)opens —
  // "Upload all" means the live fleet. If nothing is reporting connected yet,
  // fall back to every controller that has an IP so the dialog still works.
  useEffect(() => {
    if (!open) return
    const eligible = selectable.filter((m) => m.hasIp)
    const anyConnected = eligible.some((m) => m.connected)
    const init: Record<string, boolean> = {}
    for (const m of selectable) init[m.subsystemId] = m.hasIp && (anyConnected ? m.connected : true)
    setChecked(init); setJob(null); setErr(null)
  }, [open, selectable])

  // Fetch SharePoint config presence on open (no network call to Graph).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSp(null); setPushToSharePoint(false)
    apiCall<{ configured: boolean; siteUrl?: string }>('/api/sharepoint/status')
      .then((s) => { if (!cancelled) { setSp(s); setPushToSharePoint(!!s.configured) } })
      .catch(() => { if (!cancelled) setSp({ configured: false }) })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])

  const selectedIds = selectable.filter((m) => m.hasIp && checked[m.subsystemId]).map((m) => m.subsystemId)
  const running = starting || job?.status === 'running'
  const allChecked = selectable.filter((m) => m.hasIp).every((m) => checked[m.subsystemId])

  const connectedCount = selectable.filter((m) => m.hasIp && m.connected).length

  function toggleAll(v: boolean) {
    setChecked((prev) => { const next = { ...prev }; for (const m of selectable) if (m.hasIp) next[m.subsystemId] = v; return next })
  }
  function selectConnected() {
    setChecked(() => { const next: Record<string, boolean> = {}; for (const m of selectable) next[m.subsystemId] = m.hasIp && m.connected; return next })
  }

  async function start() {
    if (!selectedIds.length) return
    if (!(await confirm({
      title: 'Upload all controllers',
      danger: true,
      confirmLabel: `Upload ${selectedIds.length}`,
      message: `Upload the running program from ${selectedIds.length} controller(s)?\n\nUploading reads each controller and may take it OFFLINE. Do NOT run this on a live line without confirming it is safe.`,
    }))) return
    setStarting(true); setErr(null); setJob({ id: '', status: 'running', percent: 0, statusText: 'Starting…' })
    try {
      const r = await apiCall<{ jobId?: string; error?: string }>('/api/controller-management/upload-batch', {
        method: 'POST', body: JSON.stringify({ subsystemIds: selectedIds, pushToSharePoint: pushToSharePoint && !!sp?.configured }),
      })
      if (!r.jobId) throw new Error(r.error || 'no job created')
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(async () => {
        try {
          const j = await apiCall<BatchJob>(`/api/controller-management/job?id=${r.jobId}`)
          setJob(j)
          if (j.status !== 'running') {
            if (pollRef.current) window.clearInterval(pollRef.current); pollRef.current = null
            setStarting(false)
          }
        } catch { /* tolerate 404 mid-poll — keep polling */ }
      }, 600)
    } catch (e) { setStarting(false); setJob(null); setErr(e instanceof Error ? e.message : String(e)) }
  }

  const items = job?.items || []
  const doneCount = items.filter((i) => i.status === 'done').length
  const failCount = items.filter((i) => i.status === 'error').length

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!running) onOpenChange(v) }}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><UploadCloud className="h-5 w-5 text-primary" />Upload all controllers</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {confirmModal}
          {!job && (
            <>
              <div className="flex items-center justify-between">
                <span className={sectionLbl}>Select controllers</span>
                <div className="flex gap-3 text-xs">
                  <button onClick={selectConnected} disabled={!connectedCount} className="text-primary hover:underline disabled:opacity-40 disabled:no-underline">Connected{connectedCount ? ` (${connectedCount})` : ''}</button>
                  <button onClick={() => toggleAll(true)} className="text-primary hover:underline">Select all</button>
                  <button onClick={() => toggleAll(false)} className="text-muted-foreground hover:underline">None</button>
                </div>
              </div>
              <div className="rounded-lg border border-border divide-y divide-border">
                {selectable.map((m) => (
                  <label key={m.subsystemId} className={cn('flex items-center gap-3 px-3 py-2.5 text-sm', !m.hasIp ? 'opacity-50' : 'cursor-pointer hover:bg-muted/40')}>
                    <input type="checkbox" disabled={!m.hasIp} checked={!!checked[m.subsystemId]}
                      onChange={(e) => setChecked((p) => ({ ...p, [m.subsystemId]: e.target.checked }))}
                      className="h-4 w-4 accent-[var(--primary)]" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate flex items-center gap-2">
                        <span className="truncate">{m.name}</span>
                        {m.hasIp && (
                          <span className={cn('shrink-0 text-[10px] font-semibold uppercase tracking-wide', m.connected ? 'text-success' : 'text-muted-foreground/70')}>
                            {m.connected ? '● online' : '○ offline'}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-muted-foreground truncate">
                        {m.hasIp ? <>{m.ip} → {m.comm}</> : 'No IP configured — cannot upload'}
                      </div>
                    </div>
                  </label>
                ))}
                {!selectable.length && <div className="px-3 py-4 text-sm text-muted-foreground">No controllers available.</div>}
              </div>

              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>Uploading reads each controller and may take it <span className="font-semibold">OFFLINE</span> — do not run on a live line without confirming.</span>
              </div>

              <label className={cn('flex items-start gap-3 rounded-md border border-border px-3 py-2.5 text-sm', sp?.configured ? 'cursor-pointer hover:bg-muted/40' : 'opacity-60')}>
                <input type="checkbox" disabled={!sp?.configured} checked={pushToSharePoint}
                  onChange={(e) => setPushToSharePoint(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--primary)]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-medium"><Cloud className="h-4 w-4 text-primary shrink-0" />Push to SharePoint after upload</span>
                  <span className="block text-[11px] text-muted-foreground truncate">
                    {sp?.configured
                      ? (sp.siteUrl ? `Uploads each .acd to ${sp.siteUrl}` : 'Uploads each .acd to the configured site')
                      : 'Configure SharePoint in config.json to enable'}
                  </span>
                </span>
              </label>
            </>
          )}

          {job && (
            <div className="space-y-3">
              <div className="space-y-2">
                {items.map((it) => (
                  <div key={it.subsystemId} className="rounded-md border border-border px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        {it.status === 'done' ? <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                          : it.status === 'error' ? <XCircle className="h-4 w-4 text-destructive shrink-0" />
                          : it.status === 'running' ? <Loader2 className="h-4 w-4 text-primary animate-spin shrink-0" />
                          : <span className="h-4 w-4 rounded-full border border-border shrink-0" />}
                        <span className="font-medium truncate">{it.name}</span>
                      </span>
                      <span className="font-mono tabular-nums text-xs text-muted-foreground">{it.status === 'done' ? 100 : it.percent || 0}%</span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className={cn('h-full rounded-full transition-all duration-300', it.status === 'error' ? 'bg-destructive' : it.status === 'done' ? 'bg-success' : 'bg-primary')}
                        style={{ width: `${it.status === 'done' ? 100 : it.percent || 0}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground truncate">{it.error || it.statusText}</div>
                    {it.sharepoint && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
                        <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        {it.sharepoint.status === 'uploading' && <span className="flex items-center gap-1 text-primary"><Loader2 className="h-3 w-3 animate-spin" />Uploading to SharePoint…</span>}
                        {it.sharepoint.status === 'done' && (
                          it.sharepoint.webUrl
                            ? <a href={it.sharepoint.webUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-success hover:underline"><CheckCircle2 className="h-3 w-3" />On SharePoint</a>
                            : <span className="flex items-center gap-1 text-success"><CheckCircle2 className="h-3 w-3" />On SharePoint</span>
                        )}
                        {it.sharepoint.status === 'error' && <span className="flex items-center gap-1 text-destructive truncate"><XCircle className="h-3 w-3 shrink-0" />SharePoint: {it.sharepoint.error || 'failed'}</span>}
                        {it.sharepoint.status === 'skipped' && <span className="text-muted-foreground">SharePoint skipped</span>}
                        {it.sharepoint.status === 'pending' && <span className="text-muted-foreground">SharePoint queued</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{job.statusText}</span>
                  <span className="font-mono tabular-nums font-bold">{Math.round(job.percent || 0)}%</span>
                </div>
                <div className="mt-1 h-2.5 rounded-full bg-muted overflow-hidden">
                  <div className={cn('h-full rounded-full transition-all duration-300', job.status === 'error' ? 'bg-destructive' : job.status === 'done' ? 'bg-success' : 'bg-primary')}
                    style={{ width: `${job.status === 'done' ? 100 : job.percent || 0}%` }} />
                </div>
              </div>

              {job.status !== 'running' && (
                <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-sm', failCount ? 'border-warning/40 bg-warning/10 text-warning' : 'border-success/40 bg-success/10 text-success')}>
                  {failCount ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
                  {doneCount} uploaded, {failCount} failed.
                </div>
              )}
            </div>
          )}

          {err && <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"><XCircle className="h-4 w-4 shrink-0" />{err}</div>}

          <div className="flex justify-end gap-2">
            {!job && (
              <>
                <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button onClick={start} disabled={!selectedIds.length || running} className="gap-2">
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                  Start upload{selectedIds.length ? ` (${selectedIds.length})` : ''}
                </Button>
              </>
            )}
            {job && job.status !== 'running' && (
              <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            )}
          </div>
          {!job && allChecked && selectedIds.length > 0 && <p className="text-[11px] text-muted-foreground text-right -mt-2">All eligible controllers selected.</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
