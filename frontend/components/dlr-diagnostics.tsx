"use client"

/**
 * PLC-reported DLR ring health.
 *
 * The customer's controller runs `AOI_RACK_NETWORK_NODE`, which self-polls the
 * CIP DLR Object every 500 ms and parks the result in controller tags. This
 * surface just READS those tags on demand via `GET /api/mcm/:subsystemId/dlr`.
 * There is deliberately NO interval here — a manual Refresh plus one fetch on
 * mount, nothing else (hard project constraint: no background polling).
 *
 * This is a SECOND opinion, not a replacement for `RingHealthBadge`. That badge
 * comes from the tool's own CIP read of the ring supervisor; this one is what
 * the PLC itself believes. They are labelled distinctly on purpose so a
 * disagreement between them is visible rather than silently reconciled.
 *
 * The operationally valuable fact is `breakBetween`: the two nodes bracketing a
 * ring break. When the ring is broken that pair is shown inline on the
 * indicator, not hidden behind a disclosure.
 *
 * Honesty rules mirrored from the ladder (see lib/plc/network/dlr-aoi.ts):
 *   - comm-fault  → the module is not talking; ring state CANNOT be judged.
 *                   Never rendered as healthy or as broken.
 *   - unknown     → the status tag could not be read. Never implies "fine".
 *   - all-zero break-point data means healthy-or-never-populated, so the
 *     decoder hands us nulls and we print "none — ring closed" rather than
 *     inventing a 0.0.0.0 node.
 */

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { authFetch, getRuntimeConfig } from '@/lib/api-config'
import type { DlrAoiState, DlrAoiVerdict, DlrBreakNode } from '@/lib/plc/network/dlr-aoi'

// ── API contract ───────────────────────────────────────────────────

interface DlrReading {
  breakPresent: number | null
  communicationFaulted: boolean
  point1: number[]
  point2: number[]
}

interface DlrOk {
  ok: true
  base: string
  reading: DlrReading
  verdict: DlrAoiVerdict
}

interface DlrNotOk {
  ok: false
  reason: string
}

type DlrResponse = DlrOk | DlrNotOk

// ── Presentation tokens per state ──────────────────────────────────

interface StateStyle {
  /** Short label — colour is never the only signal. */
  label: string
  dot: string
  text: string
  /** One honest sentence about what this state does and does not tell us. */
  meaning: string
}

const STATE_STYLES: Record<DlrAoiState, StateStyle> = {
  healthy: {
    label: 'Healthy',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    meaning: 'Ring closed — the PLC reports DLR Network Status Normal.',
  },
  broken: {
    label: 'Broken',
    dot: 'bg-red-500',
    text: 'text-red-600 dark:text-red-400',
    meaning: 'The PLC reports a DLR ring fault.',
  },
  'comm-fault': {
    label: 'Comm Fault',
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    meaning:
      'The Ethernet module is not communicating, so the ring state cannot be judged — this is neither a healthy nor a broken ring.',
  },
  unknown: {
    label: 'Unknown',
    dot: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
    meaning: 'The DLR status tag could not be read — the ring state is not known.',
  },
}

// ── Data hook — on-demand only, NO setInterval ─────────────────────

interface DlrHookResult {
  data: DlrOk | null
  /** Quiet, non-modal reason we have nothing to show (never an error dialog). */
  unavailable: string | null
  loading: boolean
  refresh: () => void
}

export function useDlrStatus(subsystemId?: number): DlrHookResult {
  const [data, setData] = useState<DlrOk | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        // On a central/multi-MCM box the caller scopes us explicitly. On a
        // single-MCM tablet no id is threaded through, so fall back to the
        // configured subsystem.
        let id: string | number | undefined = subsystemId
        if (id === undefined || id === null) {
          const cfg = await getRuntimeConfig()
          id = cfg.subsystemId
        }
        if (!id) {
          if (!cancelled) { setData(null); setUnavailable('No MCM selected') }
          return
        }

        const res = await authFetch(`/api/mcm/${encodeURIComponent(String(id))}/dlr`)
        const body: DlrResponse = await res.json()
        if (cancelled) return

        if (body && body.ok) {
          setData(body)
          setUnavailable(null)
        } else {
          setData(null)
          setUnavailable(body?.reason || 'DLR status unavailable')
        }
      } catch {
        // Network/parse failure is reported inline as plain text, never as a
        // dialog — the Network page must stay usable without DLR.
        if (!cancelled) { setData(null); setUnavailable('DLR status unavailable') }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [subsystemId, nonce])

  return { data, unavailable, loading, refresh }
}

// ── (A) Compact indicator — sits beside RingHealthBadge ────────────

/** Renders the break-adjacent node pair as `ip ↔ ip`, skipping unknown sides. */
function breakNodeIps(pair: [DlrBreakNode, DlrBreakNode] | null): string | null {
  if (!pair) return null
  const a = pair[0]?.ip
  const b = pair[1]?.ip
  if (!a && !b) return null
  return `${a ?? 'unknown'} ↔ ${b ?? 'unknown'}`
}

/**
 * PLC-reported DLR state. Deliberately labelled "DLR (PLC)" so it is not read
 * as a duplicate of RingHealthBadge, which is the tool's own CIP read.
 */
export function DlrPlcBadge({ subsystemId }: { subsystemId?: number }) {
  const { data, unavailable, loading } = useDlrStatus(subsystemId)

  if (loading && !data && !unavailable) {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground">DLR (PLC) — reading…</span>
    )
  }

  if (!data) {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground" title={unavailable ?? ''}>
        DLR (PLC) — {unavailable ?? 'unavailable'}
      </span>
    )
  }

  const v = data.verdict
  const style = STATE_STYLES[v.state] ?? STATE_STYLES.unknown
  const ips = breakNodeIps(v.breakBetween)

  return (
    <div className="shrink-0 flex flex-col items-end gap-0.5" title={`${style.meaning} (${v.reason})`}>
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-semibold uppercase tracking-wide">
        <span className={cn('w-2 h-2 rounded-full', style.dot)} />
        <span className="text-muted-foreground/80">DLR (PLC)</span>
        <span className={style.text}>{style.label}</span>
      </span>

      {/* The payoff: WHERE the ring is broken, shown inline — never collapsed. */}
      {v.state === 'broken' && (
        <span className="text-[9px] text-red-600/80 dark:text-red-400/80 max-w-[280px] truncate font-mono">
          {ips ? `between ${ips}` : 'break not localized by the PLC'}
        </span>
      )}
      {v.state === 'comm-fault' && (
        <span className="text-[9px] text-amber-600/80 dark:text-amber-400/80 max-w-[280px] truncate">
          module not communicating — ring state unknown
        </span>
      )}
      {v.state === 'unknown' && (
        <span className="text-[9px] text-muted-foreground max-w-[280px] truncate">
          status tag could not be read
        </span>
      )}
    </div>
  )
}

// ── (B) Diagnostic detail block ────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1 border-b border-border/30 last:border-0">
      <span className="text-[9px] uppercase tracking-[0.2em] text-muted-foreground font-medium w-40 shrink-0">
        {label}
      </span>
      <span className="text-xs min-w-0 break-all">{children}</span>
    </div>
  )
}

function BreakNodeRow({ label, node }: { label: string; node: DlrBreakNode | null }) {
  if (!node || (!node.ip && !node.mac)) {
    return (
      <Row label={label}>
        <span className="text-muted-foreground">none — ring closed</span>
      </Row>
    )
  }
  return (
    <Row label={label}>
      <span className="font-mono">{node.ip ?? '—'}</span>
      <span className="text-muted-foreground/50 mx-2">·</span>
      <span className="font-mono text-muted-foreground">{node.mac ?? '—'}</span>
    </Row>
  )
}

/**
 * Self-contained DLR detail block for the diagnostics area. Fetches once on
 * mount; refreshes only when the operator asks. No polling.
 */
export function DlrDiagnostics({ subsystemId }: { subsystemId?: number }) {
  const { data, unavailable, loading, refresh } = useDlrStatus(subsystemId)

  const v = data?.verdict ?? null
  const style = v ? STATE_STYLES[v.state] ?? STATE_STYLES.unknown : null

  return (
    <section className="mb-4 rounded-lg border bg-card overflow-hidden">
      <header className="flex items-center gap-3 px-5 py-2.5 border-b bg-muted/30">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-foreground">
          DLR Ring (PLC-reported)
        </span>
        {style && (
          <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm border text-[10px] font-bold uppercase tracking-[0.14em]">
            <span className={cn('w-1.5 h-1.5 rounded-full', style.dot)} aria-hidden />
            <span className={style.text}>{style.label}</span>
          </span>
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-md border bg-card hover:bg-accent transition-colors disabled:opacity-50"
          title="Read the DLR tags again (on demand — this panel never polls)"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </header>

      <div className="px-5 py-3">
        {!data ? (
          <p className="text-xs text-muted-foreground">
            {loading ? 'Reading DLR tags…' : (unavailable ?? 'DLR status unavailable')}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-2.5">{style?.meaning}</p>
            <div className="flex flex-col">
              <Row label="AOI base tag">
                <span className="font-mono">{data.base || '—'}</span>
              </Row>
              <Row label="Status code">
                {v && v.statusCode !== null ? (
                  <span className="font-mono">
                    {v.statusCode}
                    <span className="text-muted-foreground"> — {v.statusLabel ?? 'unrecognised status'}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">not read</span>
                )}
              </Row>
              <Row label="Communication faulted">
                <span
                  className={cn(
                    'font-mono',
                    data.reading.communicationFaulted
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground',
                  )}
                >
                  {data.reading.communicationFaulted ? 'YES' : 'no'}
                </span>
              </Row>
              <BreakNodeRow label="Break point 1" node={v?.breakBetween?.[0] ?? null} />
              <BreakNodeRow label="Break point 2" node={v?.breakBetween?.[1] ?? null} />
              <Row label="Reason">
                <span className="text-muted-foreground">{v?.reason ?? '—'}</span>
              </Row>
            </div>
            <p className="mt-2.5 text-[10px] text-muted-foreground/70">
              The PLC polls the DLR object every 500 ms and publishes to tags; this panel reads
              those tags on demand only.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
