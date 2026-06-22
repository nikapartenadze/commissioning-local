import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  Download, Upload, Radio, Play, Square, FlaskConical, Loader2,
  CheckCircle2, XCircle, Zap, FileCog, ChevronDown, ServerCrash,
} from 'lucide-react'
import { apiCall } from '@/lib/api-config'
import { cn } from '@/lib/utils'
import { commFrom, parseComm } from '@/lib/logix-comm-path'
import { useConfirm } from './use-confirm'

interface Project { name: string; path: string; sizeBytes: number; modified: number }
interface JobState {
  id: string; status: 'running' | 'done' | 'error'; percent: number; statusText: string
  error?: string; result?: any; startedAt?: number
}
export interface ConsoleTarget { subsystemId: string; name: string; ip?: string; path?: string }

// Single-controller upload reuses the fleet /upload-batch job (one item).
interface BatchItem { name: string; status: string; percent: number; statusText?: string; error?: string; out?: string; sharepoint?: { status: string; webUrl?: string; error?: string } }
interface BatchJob { id: string; status: 'running' | 'done' | 'error'; percent: number; items?: BatchItem[]; error?: string }

// Controller-mode tones, built from the Autstand theme tokens.
const MODE_TONE: Record<string, { text: string; chip: string; dot: string; label: string }> = {
  RUN: { text: 'text-success', chip: 'border-success/40 bg-success/10', dot: 'bg-success', label: 'RUNNING' },
  PROGRAM: { text: 'text-warning', chip: 'border-warning/40 bg-warning/10', dot: 'bg-warning', label: 'PROGRAM' },
  TEST: { text: 'text-primary', chip: 'border-primary/40 bg-primary/10', dot: 'bg-primary', label: 'TEST' },
  FAULTED: { text: 'text-destructive', chip: 'border-destructive/40 bg-destructive/10', dot: 'bg-destructive', label: 'FAULTED' },
}
const tone = (m: string | null) => (m && MODE_TONE[m.toUpperCase()]) || { text: 'text-muted-foreground', chip: 'border-border bg-muted', dot: 'bg-muted-foreground/50', label: m ? m.toUpperCase() : 'UNKNOWN' }

const MODE_BTNS = [
  { m: 'PROGRAM' as const, Icon: Square, on: 'border-warning bg-warning text-warning-foreground' },
  { m: 'RUN' as const, Icon: Play, on: 'border-success bg-success text-success-foreground' },
  { m: 'TEST' as const, Icon: FlaskConical, on: 'border-primary bg-primary text-primary-foreground' },
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

const sectionLbl ='text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'
const field = 'w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary'
const btnPrimary = 'inline-flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground font-semibold shadow-sm shadow-primary/20 hover:bg-primary/90 active:bg-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

// ── Live "going online" readout for the blocking SDK ops ────────────────────
// Read / mode-change / comm-path are synchronous server calls with no streamed
// sub-progress, so we can't show a true percentage. Instead we walk through the
// REAL phase sequence the SDK performs on a time schedule, fill an asymptotic
// bar (approaches but never claims 100% until the call returns), and show a
// live elapsed clock — so a 20s wait reads as "working", not "frozen".
type SyncOp = 'comm' | 'status' | 'mode'
const OP_META: Record<SyncOp, { title: string; tone: 'primary' | 'warning'; hint: string; phases: { at: number; text: string }[] }> = {
  comm: {
    title: 'Reading project', tone: 'primary', hint: 'opening the .ACD',
    phases: [{ at: 0, text: 'Starting Logix SDK…' }, { at: 3, text: 'Opening project…' }, { at: 10, text: 'Reading stored controller path…' }],
  },
  status: {
    title: 'Going online', tone: 'primary', hint: 'about 20s — same as Studio 5000',
    phases: [{ at: 0, text: 'Starting Logix SDK…' }, { at: 3, text: 'Opening project…' }, { at: 10, text: 'Connecting to controller…' }, { at: 16, text: 'Reading controller state…' }],
  },
  mode: {
    title: 'Switching mode', tone: 'warning', hint: 'changing live controller state',
    phases: [{ at: 0, text: 'Starting Logix SDK…' }, { at: 3, text: 'Opening project…' }, { at: 10, text: 'Going online…' }, { at: 16, text: 'Sending mode change…' }, { at: 22, text: 'Confirming new mode…' }],
  },
}
function LiveOp({ kind, elapsed }: { kind: SyncOp; elapsed: number }) {
  const meta = OP_META[kind]
  const phase = meta.phases.reduce((acc, p) => (elapsed >= p.at ? p : acc), meta.phases[0])
  const pct = Math.min(95, Math.round((1 - Math.exp(-elapsed / 10)) * 100))
  const mm = Math.floor(elapsed / 60), ss = Math.floor(elapsed % 60)
  const warn = meta.tone === 'warning'
  return (
    <div role="status" aria-live="polite"
      className={cn('rounded-lg border p-4 space-y-3', warn ? 'border-warning/40 bg-warning/5' : 'border-primary/40 bg-primary/5')}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping motion-reduce:animate-none', warn ? 'bg-warning' : 'bg-primary')} />
            <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', warn ? 'bg-warning' : 'bg-primary')} />
          </span>
          <span className={cn('text-xs font-bold uppercase tracking-[0.15em]', warn ? 'text-warning' : 'text-primary')}>{meta.title}</span>
        </div>
        <span className="font-mono tabular-nums text-sm text-muted-foreground">{mm}:{String(ss).padStart(2, '0')}</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full transition-all duration-500 ease-out', warn ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="text-foreground/80">{phase.text}</span>
        <span className="text-muted-foreground/70 shrink-0">{meta.hint}</span>
      </div>
    </div>
  )
}

export function ControllerConsole({ mcm }: { mcm: ConsoleTarget }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loaded, setLoaded] = useState(false)
  const [acd, setAcd] = useState('')
  const [ip, setIp] = useState(mcm.ip || '')
  const [path, setPath] = useState(mcm.path || '1,0')
  const [mode, setMode] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [job, setJob] = useState<JobState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [, force] = useState(0)
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking')
  const [healthReason, setHealthReason] = useState('')
  const pollRef = useRef<number | null>(null)
  const [upBusy, setUpBusy] = useState(false)
  const [upJob, setUpJob] = useState<BatchJob | null>(null)
  const upPollRef = useRef<number | null>(null)
  const { confirm, confirmModal } = useConfirm()

  const selectedProject = useMemo(() => projects.find((p) => p.path === acd) || null, [projects, acd])
  const downloading = busy === 'download' || job?.status === 'running'
  const uploading = upBusy || upJob?.status === 'running'
  const comm = useMemo(() => commFrom(ip, path), [ip, path])

  // Is the Logix Designer SDK usable on this station? Field laptops without
  // Studio 5000 / the SDK simply can't program — degrade cleanly, don't error.
  useEffect(() => {
    (async () => {
      try {
        const h = await apiCall<{ ok: boolean; reason?: string; error?: string }>('/api/controller-management/health')
        if (h.ok) setHealth('ok')
        else { setHealth('down'); setHealthReason(h.reason || h.error || 'Logix Designer SDK is not installed on this station.') }
      } catch (e) { setHealth('down'); setHealthReason(e instanceof Error ? e.message : 'Could not reach the Logix SDK service.') }
    })()
  }, [])

  useEffect(() => {
    if (health !== 'ok') return
    ;(async () => {
      try {
        const r = await apiCall<{ projects: Project[] }>('/api/controller-management/projects')
        setProjects(r.projects)
        const n = norm(mcm.name)
        const exact = r.projects.find((p) => norm(p.name) === n)
        const subs = r.projects.filter((p) => { const pn = norm(p.name); return pn.includes(n) || n.includes(pn) })
        if (exact) setAcd(exact.path); else if (subs.length === 1) setAcd(subs[0].path)
      } catch (e) { setErr(`Failed to list projects: ${e instanceof Error ? e.message : e}`) }
      finally { setLoaded(true) }
    })()
  }, [mcm.name, health])

  // When an ACD is selected, reflect the path it actually targets: if Studio
  // stored a comm path, pull the IP + slot out of it; otherwise keep the MCM's.
  useEffect(() => {
    if (!acd) return
    setMode(null); setConnected(false); setJob(null)
    ;(async () => {
      setBusy('comm')
      try {
        const r = await apiCall<{ commPath: string }>('/api/controller-management/comm-path', { method: 'POST', body: JSON.stringify({ acd }) })
        const parsed = parseComm(r.commPath || '')
        if (parsed) { setIp(parsed.ip); setPath(parsed.path) }
      } catch { /* keep the MCM's IP + path */ }
      finally { setBusy(null) }
    })()
  }, [acd])

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); if (upPollRef.current) window.clearInterval(upPollRef.current) }, [])
  useEffect(() => {
    if (job?.status !== 'running') return
    const t = window.setInterval(() => force((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [job?.status])

  // Tick while a blocking SDK op (comm/status/mode) runs so the LiveOp readout
  // animates and the elapsed clock advances. opStartedAt resets each op.
  const [opStartedAt, setOpStartedAt] = useState<number | null>(null)
  useEffect(() => {
    const isSync = busy === 'comm' || busy === 'status' || busy === 'mode'
    if (!isSync) { setOpStartedAt(null); return }
    setOpStartedAt(Date.now())
    const tck = window.setInterval(() => force((n) => n + 1), 500)
    return () => window.clearInterval(tck)
  }, [busy])

  const readStatus = useCallback(async () => {
    if (!acd) return
    setBusy('status'); setErr(null); setOk(null)
    try {
      const r = await apiCall<{ mode: string; commPath: string }>('/api/controller-management/status', { method: 'POST', body: JSON.stringify({ acd, comm: comm || undefined }) })
      setMode(r.mode); setConnected(true)
    } catch (e) { setMode(null); setConnected(false); setErr(`Read failed: ${e instanceof Error ? e.message : e}`) }
    finally { setBusy(null) }
  }, [acd, comm])

  const changeMode = useCallback(async (target: 'PROGRAM' | 'RUN' | 'TEST') => {
    if (!acd) return
    if (!(await confirm({ title: `Switch to ${target}`, danger: true, confirmLabel: target, message: `Switch ${mcm.name} to ${target}? This changes the live controller state.` }))) return
    setBusy('mode'); setErr(null); setOk(null)
    try {
      const r = await apiCall<{ mode: string }>('/api/controller-management/mode', { method: 'POST', body: JSON.stringify({ acd, comm: comm || undefined, mode: target }) })
      setMode(r.mode); setConnected(true); setOk(`Controller now in ${r.mode}`)
    } catch (e) { setErr(`Mode change failed: ${e instanceof Error ? e.message : e}`) }
    finally { setBusy(null) }
  }, [acd, comm, mcm.name])

  const startDownload = useCallback(async () => {
    if (!acd) return
    if (!(await confirm({ title: 'Download program', danger: true, confirmLabel: 'Download', message: `Download "${selectedProject?.name}" to ${mcm.name}${mcm.ip ? ` (${mcm.ip})` : ''}?\n\nThe controller will be stopped (PROGRAM), the program written, then returned to RUN.` }))) return
    setBusy('download'); setErr(null); setOk(null)
    setJob({ id: '', status: 'running', percent: 0, statusText: 'Starting…', startedAt: Date.now() })
    try {
      const r = await apiCall<{ jobId: string; error?: string }>('/api/controller-management/download', { method: 'POST', body: JSON.stringify({ acd, comm: comm || undefined }) })
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
  }, [acd, comm, selectedProject, mcm])

  const startUpload = useCallback(async () => {
    if (!ip.trim()) return
    if (!(await confirm({ title: 'Upload program', danger: true, confirmLabel: 'Upload', message: `Upload the running program from ${mcm.name}${mcm.ip ? ` (${mcm.ip})` : ''} into a NEW .ACD?\n\nThis reads the controller (it may briefly go OFFLINE). The file is saved to the projects folder.` }))) return
    setUpBusy(true); setErr(null); setOk(null)
    setUpJob({ id: '', status: 'running', percent: 0, items: [{ name: mcm.name, status: 'running', percent: 0, statusText: 'Starting…' }] })
    try {
      const r = await apiCall<{ jobId: string; error?: string }>('/api/controller-management/upload-batch', { method: 'POST', body: JSON.stringify({ subsystemIds: [mcm.subsystemId] }) })
      if (!r.jobId) throw new Error(r.error || 'no job created')
      if (upPollRef.current) window.clearInterval(upPollRef.current)
      upPollRef.current = window.setInterval(async () => {
        try {
          const j = await apiCall<BatchJob>(`/api/controller-management/job?id=${r.jobId}`)
          setUpJob(j)
          if (j.status !== 'running') {
            if (upPollRef.current) window.clearInterval(upPollRef.current); upPollRef.current = null
            setUpBusy(false)
            const it = j.items?.[0]
            if (it?.status === 'done') setOk(`Upload complete${it.out ? ` → ${it.out.split(/[\\/]/).pop()}` : ''}`)
            else setErr(`Upload failed: ${it?.error || j.error || 'unknown error'}`)
          }
        } catch { /* keep polling */ }
      }, 600)
    } catch (e) { setUpBusy(false); setUpJob(null); setErr(`Could not start upload: ${e instanceof Error ? e.message : e}`) }
  }, [ip, mcm])

  const anyBusy = !!busy || upBusy
  const t = tone(mode)
  const upItem = upJob?.items?.[0]
  const curStage = stageIndex(job)
  const elapsed = job?.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0
  const downloadBlocked = !acd || anyBusy || !ip.trim()
  const syncOp: SyncOp | null = busy === 'comm' || busy === 'status' || busy === 'mode' ? busy : null
  const opElapsed = opStartedAt ? (Date.now() - opStartedAt) / 1000 : 0

  if (health === 'checking') {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center"><Loader2 className="h-4 w-4 animate-spin" />Checking Logix Designer SDK…</div>
  }
  if (health === 'down') {
    return (
      <div className="max-w-2xl rounded-lg border border-warning/40 bg-warning/10 p-5">
        <div className="flex items-start gap-3">
          <ServerCrash className="h-6 w-6 text-warning shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="font-bold text-warning">Program download isn't available on this station</h3>
            <p className="text-sm text-muted-foreground">{healthReason}</p>
            <p className="text-xs text-muted-foreground pt-1">
              Programming controllers needs <span className="font-medium text-foreground">Studio 5000</span> and the
              <span className="font-medium text-foreground"> Logix Designer SDK</span> installed on the machine running this tool.
              Everything else — connecting, configuring, and reading I/O — works normally.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {confirmModal}
      {/* live mode readout */}
      <div className={cn('flex items-center justify-between rounded-lg border p-4', t.chip)}>
        <div>
          <div className={sectionLbl}>Controller mode</div>
          <div className={cn('mt-1 text-2xl font-bold tracking-tight', connected ? t.text : 'text-muted-foreground/50')}>{connected ? t.label : '———'}</div>
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <span className={cn('h-2 w-2 rounded-full', connected ? t.dot + ' animate-pulse' : 'bg-muted-foreground/30')} />
          {connected ? 'Online' : 'Not read'}
        </div>
      </div>

      {/* program select */}
      <div className="space-y-1.5">
        <label className={sectionLbl}>Program (.ACD)</label>
        <div className="relative">
          <select value={acd} onChange={(e) => setAcd(e.target.value)} className={cn(field, 'appearance-none pr-10 cursor-pointer')}>
            <option value="">— select a program —</option>
            {projects.map((p) => <option key={p.path} value={p.path}>{p.name.replace(/\.acd$/i, '')}</option>)}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        </div>
        {loaded && !projects.length && <p className="text-xs text-muted-foreground">No .ACD programs found on this station.</p>}
      </div>

      {/* controller address — IP + path, same fields as Connect */}
      <div className="space-y-1.5">
        <label className={sectionLbl}>Controller address</label>
        <div className="flex gap-2">
          <input value={ip} onChange={(e) => setIp(e.target.value)} spellCheck={false} disabled={anyBusy}
            placeholder="192.168.5.106" aria-label="Controller IP address" className={cn(field, 'flex-1 font-mono')} />
          <input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} disabled={anyBusy}
            placeholder="1,0" aria-label="Backplane path" className={cn(field, 'w-24 font-mono text-center')} />
          <button onClick={readStatus} disabled={!acd || anyBusy || !ip.trim()} className={cn(btnPrimary, 'shrink-0 px-4 text-sm')}>
            {busy === 'status' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}Read
          </button>
        </div>
        <div className="flex justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="flex gap-3"><span>IP address</span><span className="w-24 text-center">Path (slot)</span></span>
          {comm && <span className="font-mono truncate">→ {comm}</span>}
        </div>
      </div>

      {/* mode control */}
      <div className="space-y-1.5">
        <label className={sectionLbl}>Change mode</label>
        <div className="grid grid-cols-3 gap-2">
          {MODE_BTNS.map(({ m, Icon, on }) => {
            const active = mode?.toUpperCase() === m
            return (
              <button key={m} disabled={!connected || anyBusy} onClick={() => changeMode(m)}
                className={cn('flex flex-col items-center gap-1.5 rounded-md border px-3 py-3 text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  active ? on : 'border-border bg-card text-foreground hover:border-primary/50 hover:text-primary')}>
                <Icon className="w-5 h-5" />{m}
              </button>
            )
          })}
        </div>
        {!connected && <p className="text-xs text-muted-foreground">Read the controller first to enable mode control.</p>}
      </div>

      {/* live readout for the blocking SDK ops (Read / mode / path resolve) */}
      {syncOp && <LiveOp kind={syncOp} elapsed={opElapsed} />}

      {/* download */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <span className={sectionLbl}>Program download</span>
          {downloading && <span className="font-mono text-xs tabular-nums text-muted-foreground">{elapsed}s</span>}
        </div>

        {job && (
          <div className="space-y-3">
            <div className="flex items-center">
              {STAGES.map((st, i) => {
                const done = i < curStage || job.status === 'done'
                const active = i === curStage && job.status === 'running'
                const failed = job.status === 'error' && i === curStage
                const Icon = st.icon
                return (
                  <div key={st.key} className="flex items-center flex-1 last:flex-none">
                    <div className="flex flex-col items-center gap-1">
                      <div className={cn('grid place-items-center h-8 w-8 rounded-full border-2 transition-colors',
                        failed ? 'border-destructive bg-destructive text-destructive-foreground' : done ? 'border-success bg-success text-success-foreground' : active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground')}>
                        {done ? <CheckCircle2 className="h-4 w-4" /> : active ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
                      </div>
                      <span className={cn('text-[9px] font-semibold uppercase tracking-wide', active ? 'text-primary' : done ? 'text-success' : 'text-muted-foreground')}>{st.label}</span>
                    </div>
                    {i < STAGES.length - 1 && <div className={cn('flex-1 h-0.5 mx-1 -mt-4', done ? 'bg-success' : 'bg-border')} />}
                  </div>
                )
              })}
            </div>
            <div className="h-2.5 rounded-full bg-muted overflow-hidden">
              <div className={cn('h-full rounded-full transition-all duration-300', job.status === 'error' ? 'bg-destructive' : job.status === 'done' ? 'bg-success' : 'bg-primary')} style={{ width: `${job.status === 'done' ? 100 : job.percent || 0}%` }} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground truncate">{job.statusText}</span>
              <span className="font-mono tabular-nums font-bold text-foreground">{job.status === 'done' ? 100 : job.percent || 0}%</span>
            </div>
          </div>
        )}

        {err && <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"><XCircle className="w-4 h-4 shrink-0" />{err}</div>}
        {ok && <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"><CheckCircle2 className="w-4 h-4 shrink-0" />{ok}</div>}

        <button onClick={startDownload} disabled={downloadBlocked} className={cn(btnPrimary, 'w-full py-3 text-sm')}>
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {downloading ? 'Downloading…' : 'Download program to controller'}
        </button>
        {!downloading && <p className="text-center text-xs text-muted-foreground">Stops the controller → writes the program → returns to <span className="font-medium text-success">RUN</span></p>}
      </div>

      {/* upload */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <span className={sectionLbl}>Program upload</span>
          {uploading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>
        {upItem && (
          <div className="space-y-2">
            <div className="h-2.5 rounded-full bg-muted overflow-hidden">
              <div className={cn('h-full rounded-full transition-all duration-300', upItem.status === 'error' ? 'bg-destructive' : upItem.status === 'done' ? 'bg-success' : 'bg-primary')} style={{ width: `${upItem.status === 'done' ? 100 : upItem.percent || 0}%` }} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground truncate">{upItem.statusText || (upItem.status === 'done' ? 'Done' : '…')}</span>
              <span className="font-mono tabular-nums font-bold text-foreground">{upItem.status === 'done' ? 100 : upItem.percent || 0}%</span>
            </div>
          </div>
        )}
        <button onClick={startUpload} disabled={!ip.trim() || anyBusy} className={cn(btnPrimary, 'w-full py-3 text-sm')}>
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {uploading ? 'Uploading…' : 'Upload program from controller'}
        </button>
        {!uploading && <p className="text-center text-xs text-muted-foreground">Reads the running controller into a new <span className="font-medium text-foreground">.ACD</span> in the projects folder. Use <span className="font-medium text-foreground">“Upload all”</span> on the MCM list for the whole fleet (+ SharePoint).</p>}
      </div>
    </div>
  )
}
