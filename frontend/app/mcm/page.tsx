import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Plug,
  PlugZap,
  Plus,
  Settings,
  Hexagon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

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

const POLL_MS = 2000

export default function McmLandingPage() {
  const [mcms, setMcms] = useState<McmRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(new Date())

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/mcm')
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
              <h1 className="text-sm font-semibold tracking-[0.25em] text-foreground">
                CENTRAL CONTROL
              </h1>
              <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground font-mono">
                Multi-MCM Station
              </p>
            </div>
          </div>
          <div className="flex items-center gap-8 font-mono text-xs">
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
          </div>
        </div>
      </header>

      <main className="relative max-w-7xl mx-auto px-6 py-10 z-10">
        <div className="flex items-baseline justify-between mb-8">
          <SectionTitle label="MCM Stations" />
          <Link
            to="/settings/mcms"
            className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground hover:text-primary transition-colors inline-flex items-center gap-1.5"
          >
            <Settings className="w-3.5 h-3.5" />
            Configure
          </Link>
        </div>

        {loading && <LoadingState />}
        {!loading && error && <ErrorState message={error} />}
        {!loading && !error && mcms.length === 0 && <EmptyState />}
        {!loading && !error && mcms.length > 0 && (
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
      </main>

      <footer className="relative max-w-7xl mx-auto px-6 py-6 z-10 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground border-t border-border/60">
        <span>● Polling /api/mcm every {POLL_MS / 1000}s</span>
        <span>central-tool · poc</span>
      </footer>
    </div>
  )
}

// ── pieces ────────────────────────────────────────────────────────────────

function SectionTitle({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs text-primary">[</span>
      <h2 className="font-mono text-sm uppercase tracking-[0.35em] text-foreground">
        {label}
      </h2>
      <span className="font-mono text-xs text-primary">]</span>
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
      <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-1">
        {label}
      </p>
      <p className="text-lg font-mono">{value}</p>
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
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function action(kind: 'connect' | 'disconnect') {
    setBusy(kind)
    setActionError(null)
    try {
      const r = await fetch(`/api/mcm/${mcm.subsystemId}/plc/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await r.json()
      if (!data.success) {
        setActionError(data.error || `${kind} failed`)
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  const tone = STATUS_TONES[mcm.status] ?? STATUS_TONES.disconnected

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
                'font-mono text-[10px] uppercase tracking-[0.25em]',
                tone.text
              )}
            >
              {tone.label}
            </span>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            #{mcm.subsystemId}
          </span>
        </div>

        <div>
          <h3 className="font-mono text-3xl font-semibold text-foreground tracking-tight leading-none">
            {mcm.name}
          </h3>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-[11px] font-mono">
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
          <div className="font-mono text-[10px] text-destructive border border-destructive/30 bg-destructive/5 px-2 py-1.5 rounded-sm">
            {actionError}
          </div>
        )}

        <div className="flex items-center gap-2 pt-3 border-t border-border/60">
          {mcm.connected ? (
            <button
              disabled={busy !== null}
              onClick={() => action('disconnect')}
              className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 border border-border bg-background text-foreground hover:border-destructive/60 hover:text-destructive transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
            >
              <Plug className="w-3 h-3" />
              {busy === 'disconnect' ? 'Closing…' : 'Disconnect'}
            </button>
          ) : (
            <button
              disabled={busy !== null}
              onClick={() => action('connect')}
              className="font-mono text-[11px] uppercase tracking-[0.2em] px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 rounded-sm"
            >
              <PlugZap className="w-3 h-3" />
              {busy === 'connect' ? 'Connecting…' : 'Connect'}
            </button>
          )}

          <Link
            to={`/commissioning/${mcm.subsystemId}`}
            className={cn(
              'ml-auto font-mono text-[11px] uppercase tracking-[0.2em] inline-flex items-center gap-1 transition-all',
              mcm.connected
                ? 'text-foreground hover:text-primary group-hover:translate-x-0.5'
                : 'text-muted-foreground/70 hover:text-foreground'
            )}
          >
            Enter
            <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      </div>
    </div>
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
      <dt className="text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
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
}

function LoadingState() {
  return (
    <div className="border border-border bg-card/40 rounded-sm p-16 text-center font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
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
        <p className="uppercase tracking-[0.25em] text-xs mb-1">Registry error</p>
        <p className="font-normal normal-case">{message}</p>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="border border-dashed border-border bg-card/30 rounded-sm p-16 text-center">
      <div className="inline-flex flex-col items-center gap-4">
        <div className="w-12 h-12 border border-border rounded-sm flex items-center justify-center">
          <Hexagon className="w-5 h-5 text-muted-foreground" />
        </div>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">
          No stations configured
        </p>
        <Link
          to="/settings/mcms"
          className="font-mono text-xs uppercase tracking-[0.25em] text-primary hover:text-primary/80 inline-flex items-center gap-1.5"
        >
          <Plus className="w-3 h-3" />
          Add the first MCM
        </Link>
      </div>
    </div>
  )
}
