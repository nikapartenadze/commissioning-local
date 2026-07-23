'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  CloudOff,
  ShieldAlert,
  AlertTriangle,
  HelpCircle,
  RefreshCw,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { authFetch } from '@/lib/api-config'
import type { ConnectionHealth, ConnectionHealthState } from '@/lib/cloud/connection-health'

/**
 * Cloud-connection-health banner for the top of the Sync Center.
 *
 * Turns "operator stares at Sending… wondering why" into a one-glance honest
 * answer. Self-fetches the MEASURED signal from /api/cloud/connection-status
 * (poll ~30s) and offers a "Test connection" button that runs a live probe
 * (?probe=1). The verdict is stated in plain language with an icon AND words
 * (never colour alone), and the deterministic 403 case tells the operator
 * exactly what to do — because it will never fix itself.
 */

const POLL_MS = 30_000

type BannerResponse = ConnectionHealth & { probed?: boolean }

// ─── Presentation (pure) ────────────────────────────────────────────────────

type Tone = 'ok' | 'warn' | 'error' | 'neutral'

const TONE: Record<Tone, { container: string; icon: string }> = {
  ok: {
    container:
      'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-100',
    icon: 'text-emerald-600 dark:text-emerald-400',
  },
  warn: {
    container:
      'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100',
    icon: 'text-amber-600 dark:text-amber-400',
  },
  error: {
    container:
      'border-red-300 bg-red-50 text-red-900 dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-100',
    icon: 'text-red-600 dark:text-red-400',
  },
  neutral: {
    container: 'border-border bg-muted/40 text-muted-foreground',
    icon: 'text-muted-foreground',
  },
}

function agoLabel(iso: string | null, now: number): string | null {
  if (!iso) return null
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return null
  const sec = Math.max(0, Math.round((now - then) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.round(hr / 24)}d`
}

function clockLabel(iso: string | null): string | null {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null
  return then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function httpSuffix(status: number | undefined, fallback: string): string {
  return status ? ` (HTTP ${status})` : ` (HTTP ${fallback})`
}

function results(n: number): string {
  return `${n} result${n === 1 ? '' : 's'}`
}

interface Presented {
  tone: Tone
  Icon: typeof CheckCircle2
  title: string
  detail: string | null
  urgent: boolean
}

/**
 * Map the measured health object to plain-language copy. Pure + exported so the
 * wording is trivially reviewable and could be unit-tested.
 */
export function presentConnectionHealth(h: BannerResponse, now: number): Presented {
  const waiting = h.waitingCount ?? 0
  const status = h.lastError?.httpStatus

  switch (h.state as ConnectionHealthState) {
    case 'connected': {
      const ago = agoLabel(h.lastSuccessAt, now)
      return {
        tone: 'ok',
        Icon: CheckCircle2,
        title: ago ? `Synced ${ago} ago — connected to the cloud` : 'Connected to the cloud',
        detail: waiting > 0 ? `${results(waiting)} still sending in the background.` : null,
        urgent: false,
      }
    }
    case 'unreachable': {
      const since = clockLabel(h.lastSuccessAt)
      const sinceClause = since ? ` since ${since}` : ''
      const waitingClause = waiting > 0 ? ` — ${results(waiting)} waiting` : ''
      return {
        tone: 'warn',
        Icon: CloudOff,
        title: `Can't reach the cloud (network)${sinceClause}${waitingClause}.`,
        detail:
          waiting > 0
            ? "They'll send when the connection returns. Your work is saved on this device."
            : "It'll reconnect on its own. Your work is saved on this device.",
        urgent: false,
      }
    }
    case 'auth_error': {
      return {
        tone: 'error',
        Icon: ShieldAlert,
        title: `The cloud rejected this tablet's key${status ? ` (HTTP ${status})` : ''}.`,
        detail:
          `Its API key doesn't match this project — fix it in Settings. ` +
          (waiting > 0 ? `Your ${results(waiting)} are safe.` : 'This will not fix itself.'),
        urgent: true,
      }
    }
    case 'server_error': {
      return {
        tone: 'warn',
        Icon: AlertTriangle,
        title: `The cloud is returning errors${httpSuffix(status, '5xx')}.`,
        detail:
          'Nothing to do but wait.' +
          (waiting > 0 ? ` Your ${results(waiting)} are safe on this device.` : ''),
        urgent: false,
      }
    }
    case 'unknown':
    default: {
      return {
        tone: 'neutral',
        Icon: HelpCircle,
        title: 'Haven’t reached the cloud yet this session.',
        detail: 'The tool connects automatically — use Test connection to check now.',
        urgent: false,
      }
    }
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ConnectionHealthBanner({ className }: { className?: string }) {
  const [health, setHealth] = useState<BannerResponse | null>(null)
  const [probing, setProbing] = useState(false)
  const [readError, setReadError] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const mounted = useRef(true)

  const load = useCallback(async (probe: boolean) => {
    try {
      if (probe) setProbing(true)
      const resp = await authFetch(`/api/cloud/connection-status${probe ? '?probe=1' : ''}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = (await resp.json()) as BannerResponse
      if (!mounted.current) return
      setHealth(data)
      setReadError(false)
      setNow(Date.now())
    } catch {
      if (!mounted.current) return
      // A failure to read the LOCAL status endpoint is itself unknown-not-green.
      setReadError(true)
    } finally {
      if (mounted.current && probe) setProbing(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load(false)
    const poll = setInterval(() => void load(false), POLL_MS)
    // Keep the "Xs ago" label honest between polls without refetching.
    const tick = setInterval(() => mounted.current && setNow(Date.now()), 1_000)
    return () => {
      mounted.current = false
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [load])

  // First paint, before the first response lands.
  if (!health && !readError) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground',
          className,
        )}
        role="status"
      >
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        <span>Checking cloud connection…</span>
      </div>
    )
  }

  const effective: BannerResponse =
    health ??
    ({
      state: 'unknown',
      lastSuccessAt: null,
      lastError: { message: 'Could not read connection status' },
      cloudUrl: '',
      waitingCount: 0,
    } as BannerResponse)

  const p = presentConnectionHealth(effective, now)
  const tone = TONE[p.tone]
  const { Icon } = p

  return (
    <div
      className={cn('rounded-lg border px-3 py-2.5', tone.container, className)}
      role={p.urgent ? 'alert' : 'status'}
      aria-live={p.urgent ? 'assertive' : 'polite'}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', tone.icon)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-snug">{p.title}</div>
          {p.detail && <div className="mt-0.5 text-xs leading-snug opacity-90">{p.detail}</div>}
          {readError && (
            <div className="mt-0.5 text-xs leading-snug opacity-90">
              (Showing last known state — the tool didn’t answer the status check.)
            </div>
          )}
          {effective.cloudUrl && (
            <div className="mt-1 truncate text-[11px] font-mono opacity-60" title={effective.cloudUrl}>
              {effective.cloudUrl}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={probing}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-current/25 px-2.5 py-1',
            'text-xs font-medium transition-colors hover:bg-current/10 disabled:opacity-60',
          )}
          aria-label="Test the cloud connection now"
        >
          {probing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">{probing ? 'Testing…' : 'Test connection'}</span>
        </button>
      </div>
    </div>
  )
}

export default ConnectionHealthBanner
