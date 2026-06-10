import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  Plug,
  PlugZap,
  Plus,
  Settings,
  Hexagon,
  DownloadCloud,
  Zap,
  X,
  CheckCircle2,
  XCircle,
  MinusCircle,
  LayoutGrid,
  List as ListIcon,
  ArrowUpRight,
  Terminal,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Save,
  Pencil,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/theme-toggle'
import { useUser } from '@/lib/user-context'
import { authFetch } from '@/lib/api-config'

/**
 * Whether to expose admin-only configuration controls.
 *
 * - Open mode (auth not required): everyone is an admin → always show, exactly
 *   like before.
 * - Enforced auth: show only to admins. Testers see the list + connect + Open.
 */
function useCanConfigure(): boolean {
  const { authRequired, currentUser } = useUser()
  if (!authRequired) return true
  return currentUser?.isAdmin === true
}

/**
 * Multi-MCM landing page (central-tool).
 *
 * One server, N controllers — this is the gate. The page polls /api/mcm
 * every 2 s for live status and lets the operator connect/disconnect each
 * MCM independently or drop into the existing commissioning view for any
 * one of them.
 */

interface McmRow {
  subsystemId: string
  name: string
  ip: string
  path: string
  enabled: boolean
  connected: boolean
  status: McmStatus
  tagCount: number
}

type McmStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'disconnected'

interface ConnectResultRow {
  subsystemId: string
  name: string
  success: boolean
  skipped?: boolean
  error?: string
  totalTags?: number
  tagsSuccessful?: number
  tagsFailed?: number
  pulledIos?: number
}

interface ConnectAllReport {
  kind?: 'connect' | 'disconnect'
  total: number
  connected: number // for disconnect, this holds the disconnected count
  failed: number
  skipped: number
  results: ConnectResultRow[]
  error?: string
}

const POLL_MS = 2000

export default function McmLandingPage() {
  const canConfigure = useCanConfigure()
  const [mcms, setMcms] = useState<McmRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(new Date())
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [connectingAll, setConnectingAll] = useState(false)
  const [disconnectingAll, setDisconnectingAll] = useState(false)
  const [connectReport, setConnectReport] = useState<ConnectAllReport | null>(null)
  const [view, setView] = useState<'cards' | 'list'>(() => {
    try {
      return localStorage.getItem('mcmView') === 'list' ? 'list' : 'cards'
    } catch {
      return 'cards'
    }
  })

  const changeView = useCallback((v: 'cards' | 'list') => {
    setView(v)
    try {
      localStorage.setItem('mcmView', v)
    } catch {
      /* ignore */
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch('/api/mcm')
      const data = await r.json()
      if (data && Array.isArray(data.mcms)) {
        setMcms(data.mcms as McmRow[])
        setError(null)
      } else if (data && data.error) {
        setError(String(data.error))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const importFromCloud = useCallback(async () => {
    setImporting(true)
    setImportMsg(null)
    try {
      const r = await authFetch('/api/mcm/import-from-cloud', { method: 'POST' })
      const data = await r.json()
      if (data.success) {
        const added = data.added?.length ?? 0
        const proj = data.projectName ? ` · ${data.projectName}` : ''
        setImportMsg({
          ok: true,
          text: `Imported ${data.total ?? 0} station${(data.total ?? 0) === 1 ? '' : 's'}${added ? ` · ${added} new` : ' · already up to date'}${proj}`,
        })
        await refresh()
      } else {
        setImportMsg({ ok: false, text: data.error || 'Import failed' })
      }
    } catch (e) {
      setImportMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setImporting(false)
    }
  }, [refresh])

  const connectAll = useCallback(async () => {
    setConnectingAll(true)
    setConnectReport(null)
    try {
      const r = await authFetch('/api/mcm/connect-all', { method: 'POST' })
      const data = await r.json()
      if (data && data.success) {
        setConnectReport({ ...data, kind: 'connect' } as ConnectAllReport)
      } else {
        setConnectReport({
          kind: 'connect', total: 0, connected: 0, failed: 0, skipped: 0, results: [],
          error: (data && data.error) || 'Connect All failed',
        })
      }
      await refresh()
    } catch (e) {
      setConnectReport({
        kind: 'connect', total: 0, connected: 0, failed: 0, skipped: 0, results: [],
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setConnectingAll(false)
    }
  }, [refresh])

  const disconnectAll = useCallback(async () => {
    setDisconnectingAll(true)
    setConnectReport(null)
    try {
      const r = await authFetch('/api/mcm/disconnect-all', { method: 'POST' })
      const data = await r.json()
      if (data && data.success) {
        setConnectReport({
          kind: 'disconnect',
          total: data.total,
          connected: data.disconnected, // reuse the "ok" slot for the disconnected count
          failed: data.failed,
          skipped: data.skipped,
          results: data.results || [],
        })
      } else {
        setConnectReport({
          kind: 'disconnect', total: 0, connected: 0, failed: 0, skipped: 0, results: [],
          error: (data && data.error) || 'Disconnect All failed',
        })
      }
      await refresh()
    } catch (e) {
      setConnectReport({
        kind: 'disconnect', total: 0, connected: 0, failed: 0, skipped: 0, results: [],
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setDisconnectingAll(false)
    }
  }, [refresh])

  useEffect(() => {
    refresh()
    const poll = setInterval(refresh, POLL_MS)
    const clock = setInterval(() => setNow(new Date()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(clock)
    }
  }, [refresh])

  const online = mcms.filter((m) => m.connected).length
  const utcTime = now.toISOString().slice(11, 19)

  return (
    <div className="min-h-screen bg-background text-foreground font-sans relative">
      {/* dotted grid backdrop */}
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none opacity-[0.05]"
        style={{
          backgroundImage:
            'radial-gradient(circle, currentColor 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />

      <header className="relative border-b border-border bg-card/40 backdrop-blur z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 border border-primary/50 rounded-sm flex items-center justify-center bg-card">
              <Hexagon className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-[0.14em] text-foreground">
                CENTRAL CONTROL
              </h1>
              <p className="text-[13px] uppercase tracking-[0.16em] text-muted-foreground font-mono">
                Multi-MCM Station
              </p>
            </div>
          </div>
          <div className="flex items-center gap-8 font-mono text-sm">
            <Stat
              label="Online"
              value={
                <>
                  <span className="text-primary">{online}</span>
                  <span className="text-muted-foreground">/{mcms.length}</span>
                </>
              }
            />
            <Stat label="UTC" value={<span className="text-foreground">{utcTime}</span>} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="relative max-w-7xl mx-auto px-6 py-10 z-10">
        <div className="flex items-baseline justify-between mb-2">
          <SectionTitle label="MCM Stations" />
          <div className="flex items-center gap-5">
            <div className="flex items-center border border-border rounded-sm overflow-hidden" role="group" aria-label="View mode">
              <button
                onClick={() => changeView('cards')}
                aria-pressed={view === 'cards'}
                title="Card view"
                className={cn(
                  'px-2.5 py-1.5 transition-colors',
                  view === 'cards'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                onClick={() => changeView('list')}
                aria-pressed={view === 'list'}
                title="List view"
                className={cn(
                  'px-2.5 py-1.5 transition-colors border-l border-border',
                  view === 'list'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <ListIcon className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={connectAll}
              disabled={connectingAll || mcms.length === 0}
              title="Connect every configured MCM that has an IP set"
              className="font-mono text-sm uppercase tracking-[0.2em] px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
            >
              <Zap className={cn('w-3.5 h-3.5', connectingAll && 'animate-pulse')} />
              {connectingAll ? 'Connecting…' : 'Connect All'}
            </button>
            <button
              onClick={disconnectAll}
              disabled={disconnectingAll || mcms.length === 0}
              title="Disconnect every connected MCM"
              className="font-mono text-[13px] uppercase tracking-[0.14em] px-3 py-1.5 border border-border bg-background text-foreground hover:border-destructive/60 hover:text-destructive transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
            >
              <Plug className={cn('w-3.5 h-3.5', disconnectingAll && 'animate-pulse')} />
              {disconnectingAll ? 'Disconnecting…' : 'Disconnect All'}
            </button>
            {canConfigure && (
              <button
                onClick={importFromCloud}
                disabled={importing}
                title="Pull this project's subsystems from the cloud into the station list"
                className="font-mono text-sm uppercase tracking-[0.14em] text-muted-foreground hover:text-primary transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <DownloadCloud className={cn('w-3.5 h-3.5', importing && 'animate-pulse')} />
                {importing ? 'Importing…' : 'Import from cloud'}
              </button>
            )}
            {canConfigure && (
              <Link
                to="/settings/mcms"
                className="font-mono text-sm uppercase tracking-[0.14em] text-muted-foreground hover:text-primary transition-colors inline-flex items-center gap-1.5"
              >
                <Settings className="w-3.5 h-3.5" />
                Configure
              </Link>
            )}
          </div>
        </div>

        <div className={cn(!connectReport && 'mb-8 h-4')}>
          {importMsg && (
            <p
              className={cn(
                'font-mono text-[13px] uppercase tracking-[0.2em]',
                importMsg.ok ? 'text-success' : 'text-destructive'
              )}
            >
              {importMsg.text}
            </p>
          )}
        </div>

        {connectReport && (
          <ConnectReportPanel report={connectReport} onDismiss={() => setConnectReport(null)} />
        )}

        {loading && <LoadingState />}
        {!loading && error && <ErrorState message={error} />}
        {!loading && !error && mcms.length === 0 && (
          <EmptyState onImport={importFromCloud} importing={importing} />
        )}
        {!loading && !error && mcms.length > 0 && view === 'cards' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {mcms.map((mcm, idx) => (
              <McmCard
                key={mcm.subsystemId}
                mcm={mcm}
                index={idx}
                onChanged={refresh}
              />
            ))}
          </div>
        )}
        {!loading && !error && mcms.length > 0 && view === 'list' && (
          <McmList mcms={mcms} onChanged={refresh} />
        )}

        <LogViewer />
      </main>

      <footer className="relative max-w-7xl mx-auto px-6 py-6 z-10 flex items-center justify-between font-mono text-[13px] uppercase tracking-[0.16em] text-muted-foreground border-t border-border/60">
        <span>● Polling /api/mcm every {POLL_MS / 1000}s</span>
        <span>central-tool · poc</span>
      </footer>
    </div>
  )
}

// ── Live log viewer ─────────────────────────────────────────────────────────
// Collapsed by default (zero load). When open it tails the last N lines of a
// log file via GET /api/logs/tail — that endpoint reads only the final ~512KB,
// so even with Follow on (3s poll) it puts no measurable load on the server and
// never touches the PLC/sync paths. Closing it stops all polling.
const LOG_SOURCES: { key: string; label: string }[] = [
  { key: 'app', label: 'App' },
  { key: 'tags', label: 'Tag changes' },
  { key: 'gateway', label: 'Gateway' },
  { key: 'errors', label: 'Errors' },
  { key: 'gateway-error', label: 'Gateway err' },
]

function LogViewer() {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState('app')
  const [lines, setLines] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [follow, setFollow] = useState(true)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await authFetch(`/api/logs/tail?source=${encodeURIComponent(source)}&lines=500`)
      const d = await r.json()
      if (d.success) {
        setLines(d.lines ?? [])
        setNote(d.note ?? null)
      } else {
        setNote(d.error || 'failed to read log')
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'failed to read log')
    } finally {
      setBusy(false)
    }
  }, [source])

  // Fetch on open / source change, and poll while Follow is on.
  useEffect(() => {
    if (!open) return
    void load()
    if (!follow) return
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [open, follow, load])

  // Keep pinned to the bottom while following, unless the user scrolled up.
  useEffect(() => {
    const el = boxRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <section className="mt-8 border border-border bg-card rounded-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="flex items-center gap-2">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <Terminal className="w-3.5 h-3.5" />
          Logs
        </span>
        <span className="text-[10px] normal-case tracking-normal opacity-70">
          {open ? 'tails the log file — closing stops polling' : 'click to view server logs'}
        </span>
      </button>

      {open && (
        <div className="border-t border-border">
          <div className="flex items-center gap-2 px-3 py-2 flex-wrap border-b border-border/60">
            {LOG_SOURCES.map((s) => (
              <button
                key={s.key}
                onClick={() => setSource(s.key)}
                className={cn(
                  'font-mono text-[10px] uppercase tracking-[0.15em] px-2.5 py-1 rounded-sm border transition-colors',
                  source === s.key
                    ? 'border-primary text-primary bg-primary/10'
                    : 'border-border text-muted-foreground hover:bg-muted'
                )}
              >
                {s.label}
              </button>
            ))}
            <div className="flex-1" />
            <label className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-primary" />
              Follow
            </label>
            <button
              onClick={load}
              disabled={busy}
              className="font-mono text-[10px] uppercase tracking-[0.15em] px-2.5 py-1 rounded-sm border border-border text-muted-foreground hover:bg-muted inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw className={cn('w-3 h-3', busy && 'animate-spin')} />
              Refresh
            </button>
          </div>
          <div
            ref={boxRef}
            onScroll={(e) => {
              const el = e.currentTarget
              atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
            className="h-80 overflow-auto bg-black/90 text-[11px] leading-[1.5] font-mono px-3 py-2"
          >
            {lines.length === 0 ? (
              <div className="text-muted-foreground">{note ?? 'no output'}</div>
            ) : (
              lines.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre-wrap break-all',
                    /error|fatal|fail|refus|drop/i.test(l)
                      ? 'text-red-400'
                      : /warn|park|skip/i.test(l)
                        ? 'text-amber-300'
                        : /sync done|connected|written|pulled|ok/i.test(l)
                          ? 'text-emerald-300'
                          : 'text-zinc-300'
                  )}
                >
                  {l}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// ── pieces ────────────────────────────────────────────────────────────────

function SectionTitle({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-sm text-primary">[</span>
      <h2 className="font-mono text-sm uppercase tracking-[0.18em] text-foreground">
        {label}
      </h2>
      <span className="font-mono text-sm text-primary">]</span>
    </div>
  )
}

function Stat({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="text-right leading-none">
      <p className="text-[13px] uppercase tracking-[0.16em] text-muted-foreground mb-1">
        {label}
      </p>
      <p className="text-lg font-mono">{value}</p>
    </div>
  )
}

function ConnectReportPanel({
  report,
  onDismiss,
}: {
  report: ConnectAllReport
  onDismiss: () => void
}) {
  const failures = report.results.filter((r) => !r.success && !r.skipped)
  const skipped = report.results.filter((r) => r.skipped)
  const ok = report.results.filter((r) => r.success)
  const pulledStations = report.results.filter((r) => (r.pulledIos ?? 0) > 0).length

  return (
    <div className="mb-8 border border-border bg-card rounded-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60 bg-card/60">
        <div className="flex items-center gap-4 font-mono text-sm uppercase tracking-[0.2em]">
          <span className="text-foreground">{report.kind === 'disconnect' ? 'Disconnect All' : 'Connect All'}</span>
          <span className="text-success inline-flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {report.connected} {report.kind === 'disconnect' ? 'disconnected' : 'ok'}
          </span>
          {report.failed > 0 && (
            <span className="text-destructive inline-flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" />
              {report.failed} failed
            </span>
          )}
          {report.skipped > 0 && (
            <span className="text-muted-foreground inline-flex items-center gap-1">
              <MinusCircle className="w-3.5 h-3.5" />
              {report.skipped} skipped
            </span>
          )}
          {pulledStations > 0 && (
            <span className="text-muted-foreground inline-flex items-center gap-1">
              <DownloadCloud className="w-3.5 h-3.5" />
              pulled IOs for {pulledStations}
            </span>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {report.error && (
        <div className="px-4 py-3 font-mono text-sm text-destructive">{report.error}</div>
      )}

      {(failures.length > 0 || skipped.length > 0) && (
        <ul className="divide-y divide-border/50">
          {failures.map((r) => (
            <ReportRow
              key={r.subsystemId}
              tone="error"
              name={r.name}
              sub={r.subsystemId}
              detail={r.error || 'Failed'}
            />
          ))}
          {skipped.map((r) => (
            <ReportRow
              key={r.subsystemId}
              tone="skip"
              name={r.name}
              sub={r.subsystemId}
              detail={r.error || 'Skipped'}
            />
          ))}
        </ul>
      )}

      {!report.error && failures.length === 0 && skipped.length === 0 && ok.length > 0 && (
        <div className="px-4 py-3 font-mono text-sm text-success uppercase tracking-[0.2em]">
          All {ok.length} station{ok.length === 1 ? '' : 's'} connected
        </div>
      )}
    </div>
  )
}

function ReportRow({
  tone,
  name,
  sub,
  detail,
}: {
  tone: 'error' | 'skip'
  name: string
  sub: string
  detail: string
}) {
  const Icon = tone === 'error' ? XCircle : MinusCircle
  const color = tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
  return (
    <li
      className={cn(
        'px-4 py-2.5 flex items-center gap-3 font-mono text-sm',
        tone === 'error' && 'bg-destructive/5'
      )}
    >
      <Icon className={cn('w-4 h-4 shrink-0', color)} />
      <span className="text-foreground font-medium w-32 shrink-0 truncate">{name}</span>
      <span className="text-muted-foreground w-12 shrink-0">#{sub}</span>
      <span className={cn('normal-case', tone === 'error' ? 'text-destructive' : 'text-foreground/80')}>
        {detail}
      </span>
    </li>
  )
}

// Connect/disconnect action shared by the card and list-row views.
function useMcmAction(subsystemId: string, onChanged: () => void) {
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const action = useCallback(
    async (kind: 'connect' | 'disconnect') => {
      setBusy(kind)
      setActionError(null)
      try {
        const r = await authFetch(`/api/mcm/${subsystemId}/plc/${kind}`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
        const data = await r.json()
        if (!data.success) setActionError(data.error || `${kind} failed`)
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
        onChanged()
      }
    },
    [subsystemId, onChanged]
  )

  return { busy, actionError, action }
}

// A station with no IP yet is NOT a fault — show a calm 'Set IP' state instead
// of an error/offline tone. Real PLC faults keep the red 'error' status.
function effectiveStatus(mcm: McmRow): string {
  if (!mcm.ip || !mcm.ip.trim()) return 'unconfigured'
  return mcm.status
}

// Inline IP/path editor — opened from the per-station "Set IP" button so the
// operator types the PLC IP right here instead of bouncing to /settings/mcms.
// Save persists via PUT /api/mcm/:id; "Save & Connect" then pulls IOs + connects.
function SetIpModal({
  mcm,
  onClose,
  onSaved,
}: {
  mcm: McmRow
  onClose: () => void
  onSaved: () => void
}) {
  const [ip, setIp] = useState(mcm.ip || '')
  const [path, setPath] = useState(mcm.path || '1,0')
  const [busy, setBusy] = useState<null | 'save' | 'connect'>(null)
  const [err, setErr] = useState<string | null>(null)

  async function persist(): Promise<boolean> {
    const r = await authFetch(`/api/mcm/${mcm.subsystemId}`, {
      method: 'PUT',
      body: JSON.stringify({ ip: ip.trim(), path: path.trim() || '1,0' }),
    })
    const data = await r.json()
    if (!data.success) {
      setErr(data.error || 'Save failed')
      return false
    }
    return true
  }

  async function save(thenConnect: boolean) {
    if (!ip.trim()) {
      setErr('Enter an IP address')
      return
    }
    setBusy(thenConnect ? 'connect' : 'save')
    setErr(null)
    try {
      if (!(await persist())) return
      if (thenConnect) {
        const r = await authFetch(`/api/mcm/${mcm.subsystemId}/plc/connect`, {
          method: 'POST',
          body: '{}',
        })
        const data = await r.json()
        if (!data.success) {
          setErr(data.error || 'Connect failed')
          onSaved()
          return
        }
      }
      onSaved()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md border border-primary/30 bg-card rounded-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <CornerBrackets />
        <div className="h-[3px] bg-primary/60" />
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-primary" />
              <h3 className="font-mono text-sm uppercase tracking-[0.3em] text-foreground">
                {mcm.name} · #{mcm.subsystemId}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="block sm:col-span-2">
              <span className="block font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">
                IP Address
              </span>
              <input
                autoFocus
                type="text"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') save(true)
                }}
                placeholder="192.168.20.40"
                className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </label>
            <label className="block">
              <span className="block font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">
                Path
              </span>
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') save(true)
                }}
                placeholder="1,0"
                className="w-full bg-background border border-border rounded-sm px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
              />
            </label>
          </div>

          <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
            Path is the Ethernet/IP route to the CPU (commonly{' '}
            <span className="text-foreground">1,0</span>). “Save &amp; Connect”
            pulls this station's IOs from the cloud, then connects to the PLC.
          </p>

          {err && (
            <div className="font-mono text-[11px] text-destructive border border-destructive/30 bg-destructive/5 px-3 py-2 rounded-sm">
              {err}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
            <button
              onClick={onClose}
              className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 border border-border hover:bg-muted transition-colors rounded-sm"
            >
              Cancel
            </button>
            <button
              onClick={() => save(false)}
              disabled={busy !== null}
              className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 border border-border hover:bg-muted transition-colors disabled:opacity-50 rounded-sm inline-flex items-center gap-1.5"
            >
              <Save className="w-3 h-3" />
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => save(true)}
              disabled={busy !== null}
              className="font-mono text-[11px] uppercase tracking-[0.2em] px-4 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 rounded-sm inline-flex items-center gap-1.5"
            >
              <PlugZap className="w-3 h-3" />
              {busy === 'connect' ? 'Connecting…' : 'Save & Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function McmCard({
  mcm,
  index,
  onChanged,
}: {
  mcm: McmRow
  index: number
  onChanged: () => void
}) {
  const { busy, actionError, action } = useMcmAction(mcm.subsystemId, onChanged)
  const [editIp, setEditIp] = useState(false)
  const canConfigure = useCanConfigure()
  const tone = STATUS_TONES[effectiveStatus(mcm)] ?? STATUS_TONES.disconnected

  return (
    <div
      className="relative border border-border bg-card rounded-sm overflow-hidden group hover:border-primary/40 transition-colors mcm-card-enter"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <CornerBrackets />

      {/* top status strip */}
      <div className={cn('h-[3px]', tone.strip)} />

      <div className="p-5 space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <StatusDot tone={tone.dot} pulse={tone.pulse} />
            <span
              className={cn(
                'font-mono text-[13px] uppercase tracking-[0.14em]',
                tone.text
              )}
            >
              {tone.label}
            </span>
          </div>
          <span className="font-mono text-[13px] uppercase tracking-[0.14em] text-muted-foreground">
            #{mcm.subsystemId}
          </span>
        </div>

        <div>
          <h3 className="font-mono text-3xl font-semibold text-foreground tracking-tight leading-none">
            {mcm.name}
          </h3>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-sm font-mono">
          <CardStat label="IP" value={mcm.ip || '—'} />
          <CardStat label="Path" value={mcm.path || '—'} />
          <CardStat
            label="Tags"
            value={
              <span className={mcm.connected ? 'text-foreground' : 'text-muted-foreground'}>
                {mcm.tagCount > 0 ? mcm.tagCount : '—'}
              </span>
            }
          />
          <CardStat label="Subsys" value={mcm.subsystemId} />
        </dl>

        {actionError && (
          <div className="font-mono text-[13px] text-destructive border border-destructive/30 bg-destructive/5 px-2 py-1.5 rounded-sm">
            {actionError}
          </div>
        )}

        <div className="flex items-center gap-2 pt-3 border-t border-border/60">
          {!mcm.ip ? (
            canConfigure ? (
              <button
                onClick={() => setEditIp(true)}
                className="font-mono text-sm uppercase tracking-[0.16em] px-3 py-1.5 border border-border bg-background text-foreground hover:border-primary/60 hover:text-primary transition-colors inline-flex items-center gap-1.5 rounded-sm"
              >
                <Settings className="w-3.5 h-3.5" />
                Set IP
              </button>
            ) : (
              <span className="font-mono text-sm uppercase tracking-[0.16em] px-3 py-1.5 text-muted-foreground inline-flex items-center gap-1.5">
                No IP set
              </span>
            )
          ) : mcm.connected ? (
            <button
              disabled={busy !== null}
              onClick={() => action('disconnect')}
              className="font-mono text-sm uppercase tracking-[0.16em] px-3 py-1.5 border border-border bg-background text-foreground hover:border-destructive/60 hover:text-destructive transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
            >
              <Plug className="w-3.5 h-3.5" />
              {busy === 'disconnect' ? 'Closing…' : 'Disconnect'}
            </button>
          ) : (
            <button
              disabled={busy !== null}
              onClick={() => action('connect')}
              className="font-mono text-sm uppercase tracking-[0.16em] px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
            >
              <PlugZap className="w-3.5 h-3.5" />
              {busy === 'connect' ? 'Connecting…' : 'Connect'}
            </button>
          )}

          {mcm.ip && canConfigure && (
            <button
              onClick={() => setEditIp(true)}
              title="Edit IP / path"
              className="font-mono text-sm uppercase tracking-[0.16em] px-2.5 py-1.5 border border-border bg-background text-muted-foreground hover:border-primary/60 hover:text-primary transition-colors inline-flex items-center gap-1.5 rounded-sm"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}

          <Link
            to={`/commissioning/${mcm.subsystemId}`}
            title="Open this subsystem's commissioning screen"
            className="ml-auto font-mono text-sm uppercase tracking-[0.16em] px-3 py-1.5 border border-border bg-background text-foreground hover:border-primary/60 hover:text-primary transition-colors inline-flex items-center gap-1.5 rounded-sm"
          >
            Open
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {editIp && (
        <SetIpModal
          mcm={mcm}
          onClose={() => setEditIp(false)}
          onSaved={onChanged}
        />
      )}
    </div>
  )
}

// ── List view ───────────────────────────────────────────────────────────────

function McmList({
  mcms,
  onChanged,
}: {
  mcms: McmRow[]
  onChanged: () => void
}) {
  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <div className="hidden md:flex items-center gap-4 px-4 py-2.5 bg-card/60 border-b border-border/60 font-mono text-[13px] uppercase tracking-[0.14em] text-muted-foreground">
        <span className="w-32 shrink-0">Status</span>
        <span className="flex-1 min-w-0">Station</span>
        <span className="w-40 shrink-0">IP</span>
        <span className="w-14 shrink-0 text-right">Tags</span>
        <span className="w-[15.5rem] shrink-0 text-right">Actions</span>
      </div>
      <ul className="divide-y divide-border/50">
        {mcms.map((mcm) => (
          <McmListRow key={mcm.subsystemId} mcm={mcm} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  )
}

function McmListRow({ mcm, onChanged }: { mcm: McmRow; onChanged: () => void }) {
  const { busy, actionError, action } = useMcmAction(mcm.subsystemId, onChanged)
  const [editIp, setEditIp] = useState(false)
  const canConfigure = useCanConfigure()
  const tone = STATUS_TONES[effectiveStatus(mcm)] ?? STATUS_TONES.disconnected

  const btnBase =
    'font-mono text-[13px] uppercase tracking-[0.12em] px-2.5 py-1.5 rounded-sm inline-flex items-center gap-1.5 transition-colors disabled:opacity-50'

  return (
    <li className="px-4 py-3 hover:bg-card/40 transition-colors">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-sm">
        <div className="flex items-center gap-2 w-32 shrink-0">
          <StatusDot tone={tone.dot} pulse={tone.pulse} />
          <span className={cn('uppercase tracking-[0.12em] text-[13px]', tone.text)}>
            {tone.label}
          </span>
        </div>

        <div className="flex-1 min-w-[8rem]">
          <span className="text-foreground font-medium">{mcm.name}</span>
          <span className="text-muted-foreground ml-2">#{mcm.subsystemId}</span>
        </div>

        <span
          className={cn(
            'w-40 shrink-0 truncate',
            mcm.ip ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {mcm.ip || 'No IP'}
        </span>

        <span
          className={cn(
            'w-14 shrink-0 text-right',
            mcm.connected ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {mcm.tagCount > 0 ? mcm.tagCount : '—'}
        </span>

        <div className="flex items-center justify-end gap-2 w-[15.5rem] shrink-0">
          {!mcm.ip ? (
            canConfigure ? (
              <button
                onClick={() => setEditIp(true)}
                className={cn(btnBase, 'border border-border bg-background text-foreground hover:border-primary/60 hover:text-primary')}
              >
                <Settings className="w-3.5 h-3.5" />
                Set IP
              </button>
            ) : (
              <span className={cn(btnBase, 'text-muted-foreground')}>No IP set</span>
            )
          ) : mcm.connected ? (
            <button
              disabled={busy !== null}
              onClick={() => action('disconnect')}
              className={cn(btnBase, 'border border-border bg-background text-foreground hover:border-destructive/60 hover:text-destructive')}
            >
              <Plug className="w-3.5 h-3.5" />
              {busy === 'disconnect' ? '…' : 'Disconnect'}
            </button>
          ) : (
            <button
              disabled={busy !== null}
              onClick={() => action('connect')}
              className={cn(btnBase, 'bg-primary text-primary-foreground hover:bg-primary/90')}
            >
              <PlugZap className="w-3.5 h-3.5" />
              {busy === 'connect' ? '…' : 'Connect'}
            </button>
          )}

          {mcm.ip && canConfigure && (
            <button
              onClick={() => setEditIp(true)}
              title="Edit IP / path"
              className={cn(btnBase, 'border border-border bg-background text-muted-foreground hover:border-primary/60 hover:text-primary')}
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}

          <Link
            to={`/commissioning/${mcm.subsystemId}`}
            title="Open this subsystem's commissioning screen"
            className={cn(btnBase, 'border border-border bg-background text-foreground hover:border-primary/60 hover:text-primary')}
          >
            Open
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {actionError && (
        <div className="mt-2 ml-32 font-mono text-[13px] text-destructive normal-case">
          {actionError}
        </div>
      )}

      {editIp && (
        <SetIpModal
          mcm={mcm}
          onClose={() => setEditIp(false)}
          onSaved={onChanged}
        />
      )}
    </li>
  )
}

function CardStat({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[13px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  )
}

function CornerBrackets() {
  const base = 'absolute w-2.5 h-2.5 border-primary/40 pointer-events-none'
  return (
    <>
      <span className={cn(base, 'top-0 left-0 border-t border-l')} />
      <span className={cn(base, 'top-0 right-0 border-t border-r')} />
      <span className={cn(base, 'bottom-0 left-0 border-b border-l')} />
      <span className={cn(base, 'bottom-0 right-0 border-b border-r')} />
    </>
  )
}

function StatusDot({ tone, pulse }: { tone: string; pulse: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {pulse && (
        <span
          className={cn(
            'animate-ping absolute inline-flex h-full w-full rounded-full opacity-60',
            tone
          )}
        />
      )}
      <span className={cn('relative inline-flex rounded-full h-2 w-2', tone)} />
    </span>
  )
}

const STATUS_TONES: Record<
  string,
  { label: string; dot: string; text: string; strip: string; pulse: boolean }
> = {
  connected: {
    label: 'Online',
    dot: 'bg-success',
    text: 'text-success',
    strip: 'bg-success/80',
    pulse: true,
  },
  connecting: {
    label: 'Connecting',
    dot: 'bg-warning',
    text: 'text-warning',
    strip: 'bg-warning/80',
    pulse: true,
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-warning',
    text: 'text-warning',
    strip: 'bg-warning/80',
    pulse: true,
  },
  disconnected: {
    label: 'Offline',
    dot: 'bg-muted-foreground/70',
    text: 'text-muted-foreground',
    strip: 'bg-border',
    pulse: false,
  },
  error: {
    label: 'Fault',
    dot: 'bg-destructive',
    text: 'text-destructive',
    strip: 'bg-destructive/80',
    pulse: true,
  },
  idle: {
    label: 'Idle',
    dot: 'bg-muted-foreground/70',
    text: 'text-muted-foreground',
    strip: 'bg-border',
    pulse: false,
  },
  // No IP configured yet — a setup state, deliberately NOT an error tone.
  unconfigured: {
    label: 'Set IP',
    dot: 'bg-muted-foreground/50',
    text: 'text-muted-foreground',
    strip: 'bg-border',
    pulse: false,
  },
}

function LoadingState() {
  return (
    <div className="border border-border bg-card/40 rounded-sm p-16 text-center font-mono text-sm uppercase tracking-[0.16em] text-muted-foreground">
      <Activity className="w-4 h-4 inline-block mr-2 animate-pulse" />
      Reading station registry
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="border border-destructive/40 bg-destructive/5 p-6 rounded-sm font-mono text-sm text-destructive flex items-start gap-3">
      <AlertTriangle className="w-4 h-4 mt-0.5" />
      <div>
        <p className="uppercase tracking-[0.14em] text-sm mb-1">Registry error</p>
        <p className="font-normal normal-case">{message}</p>
      </div>
    </div>
  )
}

function EmptyState({
  onImport,
  importing,
}: {
  onImport: () => void
  importing: boolean
}) {
  return (
    <div className="border border-dashed border-border bg-card/30 rounded-sm p-16 text-center">
      <div className="inline-flex flex-col items-center gap-4">
        <div className="w-12 h-12 border border-border rounded-sm flex items-center justify-center">
          <Hexagon className="w-5 h-5 text-muted-foreground" />
        </div>
        <p className="font-mono text-sm uppercase tracking-[0.16em] text-muted-foreground">
          No stations configured
        </p>
        <button
          onClick={onImport}
          disabled={importing}
          className="font-mono text-sm uppercase tracking-[0.14em] px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
        >
          <DownloadCloud className={cn('w-3.5 h-3.5', importing && 'animate-pulse')} />
          {importing ? 'Importing…' : 'Import stations from cloud'}
        </button>
        <Link
          to="/settings/mcms"
          className="font-mono text-sm uppercase tracking-[0.14em] text-muted-foreground hover:text-primary inline-flex items-center gap-1.5"
        >
          <Plus className="w-3 h-3" />
          or add one manually
        </Link>
      </div>
    </div>
  )
}
