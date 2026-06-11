import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  X, Download, Radio, Play, Square, FlaskConical, Loader2,
  CheckCircle2, XCircle, Zap, FileCog, AlertTriangle,
} from 'lucide-react'
import { apiCall } from '@/lib/api-config'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

interface Project { name: string; path: string; sizeBytes: number; modified: number }
interface JobState {
  id: string; status: 'running' | 'done' | 'error'; percent: number; statusText: string
  error?: string; result?: any; startedAt?: number
}
interface McmTarget { subsystemId: string; name: string; ip?: string; path?: string }

function CornerBrackets() {
  const c = 'absolute w-2.5 h-2.5 border-primary/50'
  return (
    <>
      <span className={`${c} top-0 left-0 border-t border-l`} />
      <span className={`${c} top-0 right-0 border-t border-r`} />
      <span className={`${c} bottom-0 left-0 border-b border-l`} />
      <span className={`${c} bottom-0 right-0 border-b border-r`} />
    </>
  )
}

// High-contrast status language. Works in light + dark.
const MODE_TONE: Record<string, { text: string; box: string; dot: string; label: string }> = {
  RUN: { text: 'text-emerald-600 dark:text-emerald-400', box: 'border-emerald-500/60 bg-emerald-500/10', dot: 'bg-emerald-500', label: 'RUNNING' },
  PROGRAM: { text: 'text-amber-600 dark:text-amber-400', box: 'border-amber-500/60 bg-amber-500/10', dot: 'bg-amber-500', label: 'PROGRAM' },
  TEST: { text: 'text-sky-600 dark:text-sky-400', box: 'border-sky-500/60 bg-sky-500/10', dot: 'bg-sky-500', label: 'TEST' },
  FAULTED: { text: 'text-red-600 dark:text-red-400', box: 'border-red-500/60 bg-red-500/10', dot: 'bg-red-500', label: 'FAULTED' },
}
const tone = (m: string | null) => (m && MODE_TONE[m.toUpperCase()]) || { text: 'text-muted-foreground', box: 'border-border bg-muted/30', dot: 'bg-muted-foreground', label: m ? m.toUpperCase() : 'UNKNOWN' }

const MODE_BTNS = [
  { m: 'PROGRAM' as const, Icon: Square, on: 'border-amber-500 bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  { m: 'RUN' as const, Icon: Play, on: 'border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  { m: 'TEST' as const, Icon: FlaskConical, on: 'border-sky-500 bg-sky-500/15 text-sky-600 dark:text-sky-400' },
]

const STAGES = [
  { key: 'connect', label: 'Connect', icon: Radio },
  { key: 'program', label: 'Program', icon: Square },
  { key: 'transfer', label: 'Transfer', icon: Download },
  { key: 'link', label: 'Link', icon: Zap },
  { key: 'finalize', label: 'Finalize', icon: FileCog },
  { key: 'run', label: 'Run', icon: Play },
]
function stageIndex(job: JobState | null): number {
  if (!job) return -1
  if (job.status === 'done') return STAGES.length
  const s = (job.statusText || '').toLowerCase()
  if (s.includes('run')) return 5
  if (s.includes('save') || s.includes('finaliz')) return 4
  if (s.includes('linking')) return 3
  if (s.includes('download') || s.includes('verifying') || s.includes('object collection')) return 2
  if (s.includes('program') || s.includes('change controller mode')) return 1
  return 0
}

const norm = (s: string) => s.toLowerCase().replace(/\.acd$/i, '').replace(/[^a-z0-9]/g, '')
const lbl = 'block font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5'
const fld = 'w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30'

export function ControllerDownloadModal({ mcm, onClose }: { mcm: McmTarget; onClose: () => void }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loaded, setLoaded] = useState(false)
  const [acd, setAcd] = useState<string>('')
  const [commPath, setCommPath] = useState('')
  const [commGuessed, setCommGuessed] = useState(false)
  const [mode, setMode] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [job, setJob] = useState<JobState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [, force] = useState(0)
  const pollRef = useRef<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const selectedProject = useMemo(() => projects.find((p) => p.path === acd) || null, [projects, acd])
  const downloading = busy === 'download' || job?.status === 'running'

  const requestClose = useCallback(() => {
    if (downloading && !window.confirm('A download is in progress. Close this view? The download keeps running on the server.')) return
    onClose()
  }, [downloading, onClose])

  // ESC to close + focus the panel + lock background scroll
  useEffect(() => {
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow }
  }, [requestClose])

  // load projects, auto-match the one for this MCM (exact first; single fuzzy only)
  useEffect(() => {
    (async () => {
      try {
        const r = await apiCall<{ projects: Project[] }>('/api/controller-management/projects')
        setProjects(r.projects)
        const n = norm(mcm.name)
        const exact = r.projects.find((p) => norm(p.name) === n)
        const subs = r.projects.filter((p) => { const pn = norm(p.name); return pn.includes(n) || n.includes(pn) })
        if (exact) setAcd(exact.path)
        else if (subs.length === 1) setAcd(subs[0].path)
      } catch (e) { setErr(`Failed to list projects: ${e instanceof Error ? e.message : e}`) }
      finally { setLoaded(true) }
    })()
  }, [mcm.name])

  // when a project is chosen, read its stored comm path (fall back to a flagged guess)
  useEffect(() => {
    if (!acd) { setCommPath(''); setCommGuessed(false); return }
    setMode(null); setConnected(false); setJob(null)
    ;(async () => {
      setBusy('comm')
      try {
        const r = await apiCall<{ commPath: string }>('/api/controller-management/comm-path', {
          method: 'POST', body: JSON.stringify({ acd }),
        })
        if (r.commPath) { setCommPath(r.commPath); setCommGuessed(false) }
        else { setCommPath(mcm.ip ? `AB_ETH-2\\${mcm.ip}` : ''); setCommGuessed(!!mcm.ip) }
      } catch { setCommPath(mcm.ip ? `AB_ETH-2\\${mcm.ip}` : ''); setCommGuessed(!!mcm.ip) }
      finally { setBusy(null) }
    })()
  }, [acd, mcm.ip])

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])
  useEffect(() => {
    if (job?.status !== 'running') return
    const t = window.setInterval(() => force((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [job?.status])

  const readStatus = useCallback(async () => {
    if (!acd) return
    setBusy('status'); setErr(null); setOk(null)
    try {
      const r = await apiCall<{ mode: string; commPath: string }>('/api/controller-management/status', {
        method: 'POST', body: JSON.stringify({ acd, comm: commPath || undefined }),
      })
      setMode(r.mode); setConnected(true)
      if (r.commPath) { setCommPath(r.commPath); setCommGuessed(false) }
    } catch (e) { setMode(null); setConnected(false); setErr(`Read failed: ${e instanceof Error ? e.message : e}`) }
    finally { setBusy(null) }
  }, [acd, commPath])

  const changeMode = useCallback(async (target: 'PROGRAM' | 'RUN' | 'TEST') => {
    if (!acd) return
    if (!window.confirm(`Switch ${mcm.name} to ${target}? This changes the live controller state.`)) return
    setBusy('mode'); setErr(null); setOk(null)
    try {
      const r = await apiCall<{ mode: string }>('/api/controller-management/mode', {
        method: 'POST', body: JSON.stringify({ acd, comm: commPath || undefined, mode: target }),
      })
      setMode(r.mode); setConnected(true); setOk(`Controller now in ${r.mode}`)
    } catch (e) { setErr(`Mode change failed: ${e instanceof Error ? e.message : e}`) }
    finally { setBusy(null) }
  }, [acd, commPath, mcm.name])

  const startDownload = useCallback(async () => {
    if (!acd) return
    if (!window.confirm(
      `Download "${selectedProject?.name}" to ${mcm.name}${mcm.ip ? ` (${mcm.ip})` : ''}?\n\n` +
      `The controller will be stopped (PROGRAM), the program written, then returned to RUN.`,
    )) return
    setBusy('download'); setErr(null); setOk(null)
    setJob({ id: '', status: 'running', percent: 0, statusText: 'Starting…', startedAt: Date.now() })
    try {
      const r = await apiCall<{ jobId: string; error?: string }>('/api/controller-management/download', {
        method: 'POST', body: JSON.stringify({ acd, comm: commPath || undefined }),
      })
      if (!r.jobId) throw new Error(r.error || 'no job created')
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(async () => {
        try {
          const j = await apiCall<JobState>(`/api/controller-management/job?id=${r.jobId}`)
          setJob(j)
          if (j.status !== 'running') {
            if (pollRef.current) window.clearInterval(pollRef.current); pollRef.current = null
            setBusy(null)
            if (j.status === 'done') { setOk('Download complete — controller in RUN'); setMode('RUN'); setConnected(true) }
            else setErr(`Download failed: ${j.error || 'unknown error'}`)
          }
        } catch { /* keep polling */ }
      }, 600)
    } catch (e) { setBusy(null); setJob(null); setErr(`Could not start: ${e instanceof Error ? e.message : e}`) }
  }, [acd, commPath, selectedProject, mcm])

  const anyBusy = !!busy
  const t = tone(mode)
  const curStage = stageIndex(job)
  const elapsed = job?.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0
  const downloadBlocked = !acd || anyBusy || (commGuessed && !connected)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4" onClick={requestClose}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Program download — ${mcm.name}`}
        className="relative w-full max-w-lg border border-primary/30 bg-card rounded-sm max-h-[92vh] overflow-y-auto outline-none" onClick={(e) => e.stopPropagation()}>
        <CornerBrackets />
        <div className="h-[3px] bg-primary/60" />
        <div className="p-5 space-y-5">
          {/* header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Download className="w-4 h-4 text-primary" />
              <h3 className="font-mono text-sm uppercase tracking-[0.3em] text-foreground">
                {mcm.name} <span className="text-muted-foreground">· #{mcm.subsystemId}</span>
              </h3>
            </div>
            <button onClick={requestClose} className="text-muted-foreground hover:text-foreground" aria-label="Close"><X className="w-4 h-4" /></button>
          </div>

          {/* station + mode readout */}
          <div className={`grid grid-cols-[1fr_auto] gap-4 border rounded-sm p-3.5 ${t.box}`}>
            <div className="min-w-0">
              <span className={lbl}>Target station</span>
              <div className="font-mono text-base font-bold text-foreground leading-none">{mcm.name}</div>
              <div className="font-mono text-xs text-muted-foreground mt-1.5">{mcm.ip || 'no IP'}{mcm.path ? ` · ${mcm.path}` : ''}</div>
            </div>
            <div className="text-right">
              <div className="flex items-center justify-end gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${connected ? t.dot + ' animate-pulse' : 'bg-muted-foreground/40'}`} />
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">{connected ? 'online' : 'not read'}</span>
              </div>
              <div className={`font-mono text-xl font-bold leading-none mt-1.5 ${connected ? t.text : 'text-muted-foreground/60'}`}>{connected ? t.label : '———'}</div>
            </div>
          </div>

          {/* project picker */}
          <div>
            <span className={lbl}>Program (.ACD)</span>
            <Select value={acd} onValueChange={setAcd}>
              <SelectTrigger className="w-full bg-background border-border rounded-sm font-mono text-sm focus:ring-1 focus:ring-primary/30">
                <SelectValue placeholder="— select project —" />
              </SelectTrigger>
              <SelectContent className="font-mono">
                {projects.map((p) => <SelectItem key={p.path} value={p.path} className="text-sm">{p.name.replace(/\.acd$/i, '')}</SelectItem>)}
              </SelectContent>
            </Select>
            {loaded && !projects.length && <p className="font-mono text-[10px] text-muted-foreground mt-1.5">No .ACD projects found on this station.</p>}
          </div>

          {/* comm path */}
          <div>
            <span className={lbl}>Communications path</span>
            <div className="flex gap-2">
              <input value={commPath} onChange={(e) => { setCommPath(e.target.value); setCommGuessed(false) }} spellCheck={false}
                placeholder={'AB_ETH-2\\192.168.5.107'} className={fld} disabled={!acd} />
              <button onClick={readStatus} disabled={!acd || anyBusy}
                className="shrink-0 font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 rounded-sm inline-flex items-center gap-1.5">
                {busy === 'status' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}Read
              </button>
            </div>
            {commGuessed && (
              <p className="font-mono text-[10px] text-amber-600 dark:text-amber-400 mt-1.5 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0" />Guessed from IP — verify the Ethernet module name, then Read before downloading.
              </p>
            )}
          </div>

          {/* mode control — only after a successful read */}
          <div>
            <span className={lbl}>Controller mode</span>
            <div className="grid grid-cols-3 gap-2">
              {MODE_BTNS.map(({ m, Icon, on }) => {
                const active = mode?.toUpperCase() === m
                return (
                  <button key={m} disabled={!connected || anyBusy} onClick={() => changeMode(m)}
                    className={`relative rounded-sm border px-2 py-2.5 flex flex-col items-center gap-1 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${active ? on + ' font-bold' : 'border-border bg-background text-foreground hover:border-primary/60 hover:text-primary'}`}>
                    <Icon className="w-4 h-4" />{m}
                  </button>
                )
              })}
            </div>
            {!connected && <p className="font-mono text-[10px] text-muted-foreground mt-1.5">Read the controller first to enable mode control.</p>}
          </div>

          {/* download pipeline */}
          {job && (
            <div className="space-y-3 border-t border-border/60 pt-4">
              <div className="flex items-center">
                {STAGES.map((st, i) => {
                  const done = i < curStage || job.status === 'done'
                  const active = i === curStage && job.status === 'running'
                  const failed = job.status === 'error' && i === curStage
                  const Icon = st.icon
                  return (
                    <div key={st.key} className="flex items-center flex-1 last:flex-none">
                      <div className="flex flex-col items-center gap-1">
                        <div className={`grid place-items-center h-7 w-7 rounded-sm border transition-colors ${failed ? 'border-red-500 bg-red-500/20 text-red-500' : done ? 'border-emerald-500 bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : active ? 'border-primary bg-primary/20 text-primary' : 'border-border bg-background text-muted-foreground/50'}`}>
                          {done ? <CheckCircle2 className="h-4 w-4" /> : active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
                        </div>
                        <span className={`font-mono text-[8px] uppercase tracking-wider ${active ? 'text-primary' : done ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/50'}`}>{st.label}</span>
                      </div>
                      {i < STAGES.length - 1 && <div className={`flex-1 h-0.5 mx-1 -mt-3.5 ${done ? 'bg-emerald-500/60' : 'bg-border'}`} />}
                    </div>
                  )
                })}
              </div>
              <div className="h-2 rounded-sm bg-muted overflow-hidden border border-border">
                <div className={`h-full transition-all duration-300 ${job.status === 'error' ? 'bg-red-500' : job.status === 'done' ? 'bg-emerald-500' : 'bg-primary'}`} style={{ width: `${job.status === 'done' ? 100 : job.percent || 0}%` }} />
              </div>
              <div className="flex items-center justify-between font-mono text-[11px]">
                <span className="text-muted-foreground truncate">{job.statusText}</span>
                <span className="tabular-nums font-bold text-foreground">{job.status === 'done' ? 100 : job.percent || 0}% · {elapsed}s</span>
              </div>
            </div>
          )}

          {/* messages */}
          {err && <div className="font-mono text-[11px] text-destructive border border-destructive/30 bg-destructive/5 px-3 py-2 rounded-sm flex items-center gap-1.5"><XCircle className="w-3.5 h-3.5 shrink-0" />{err}</div>}
          {ok && <div className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 rounded-sm flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 shrink-0" />{ok}</div>}

          {/* download action */}
          <div className="border-t border-border/60 pt-4 space-y-2">
            <button onClick={startDownload} disabled={downloadBlocked}
              className="w-full font-mono text-xs uppercase tracking-[0.2em] font-bold px-4 py-3 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed rounded-sm inline-flex items-center justify-center gap-2">
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {downloading ? 'Downloading…' : 'Download program to controller'}
            </button>
            {!downloading && (
              <p className="font-mono text-[10px] leading-relaxed text-muted-foreground text-center">
                Stops the controller → writes the program → returns to <span className="text-emerald-600 dark:text-emerald-400">RUN</span>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
