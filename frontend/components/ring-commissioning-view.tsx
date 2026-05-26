"use client"

import { useState, useEffect, useCallback } from 'react'
import { authFetch } from '@/lib/api-config'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  Loader2, Play, Save, CheckCircle2, XCircle, AlertTriangle, MinusCircle, Network, Cable, Gauge,
} from 'lucide-react'

// ── Client mirrors of the server report shapes (lib/network/ring/types.ts) ──

type CheckState = 'pass' | 'fail' | 'warn' | 'skip'
interface CheckItem { state: CheckState; message: string }
interface LinkCheck {
  localDpm: string; localPort: number
  expectedRemoteDpm?: string; expectedRemotePort?: number
  actualRemoteDpm?: string; actualRemotePort?: number
  state: CheckState; message: string
}
interface PortTerminationCheck {
  dpm: string; port: number; linkUp: boolean; speedMbps: number
  expectedSpeedMbps?: number; fullDuplex: boolean | null; errorsTotal: number
  state: CheckState; message: string
}
interface DpmReport {
  dpmName: string; ip: string; reachable: boolean
  ringHealth: CheckItem; links: LinkCheck[]; terminations: PortTerminationCheck[]
}
interface RingCheckReport {
  ringId: number; ringName: string; generatedAt: number; hasBaseline: boolean
  overall: CheckState; reachability: CheckItem; dpms: DpmReport[]
  summary: { pass: number; fail: number; warn: number; skip: number }
}
interface RingBaseline { savedBy?: string; savedAt: number; links: unknown[] }

export interface RingRef { id: number; name: string }

interface Props {
  rings: RingRef[]
  active: boolean
}

// ── State presentation ──────────────────────────────────────────────────────

const STATE_META: Record<CheckState, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  pass: { label: 'PASS', cls: 'text-emerald-600 dark:text-emerald-400 border-emerald-600/40 bg-emerald-600/10', Icon: CheckCircle2 },
  fail: { label: 'FAIL', cls: 'text-red-600 dark:text-red-400 border-red-600/40 bg-red-600/10', Icon: XCircle },
  warn: { label: 'WARN', cls: 'text-amber-600 dark:text-amber-400 border-amber-600/40 bg-amber-600/10', Icon: AlertTriangle },
  skip: { label: 'REVIEW', cls: 'text-muted-foreground border-border bg-muted/40', Icon: MinusCircle },
}

function StatePill({ state, children }: { state: CheckState; children?: React.ReactNode }) {
  const m = STATE_META[state]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium', m.cls)}>
      <m.Icon className="w-3 h-3" />
      {children ?? m.label}
    </span>
  )
}

function operatorName(): string | undefined {
  try { return localStorage.getItem('tester-name') ?? undefined } catch { return undefined }
}

export function RingCommissioningView({ rings, active }: Props) {
  const [ringId, setRingId] = useState<number | null>(rings[0]?.id ?? null)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<RingCheckReport | null>(null)
  const [scan, setScan] = useState<unknown>(null)
  const [baseline, setBaseline] = useState<RingBaseline | null>(null)

  // Keep a valid selection as rings load.
  useEffect(() => {
    if (ringId == null && rings.length > 0) setRingId(rings[0].id)
  }, [rings, ringId])

  const loadBaseline = useCallback(async (rid: number) => {
    try {
      const res = await authFetch(`/api/network/ring-baseline?ringId=${rid}`)
      const data = await res.json()
      setBaseline(data?.baseline ?? null)
    } catch {
      setBaseline(null)
    }
  }, [])

  // Load baseline status when the view opens or the ring changes.
  useEffect(() => {
    if (!active || ringId == null) return
    setReport(null)
    setScan(null)
    setError(null)
    loadBaseline(ringId)
  }, [active, ringId, loadBaseline])

  async function runCheck() {
    if (ringId == null) return
    setRunning(true)
    setError(null)
    try {
      const res = await authFetch('/api/network/ring-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ringId, runBy: operatorName() }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Check failed')
      setReport(data.report)
      setScan(data.scan)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check failed')
    } finally {
      setRunning(false)
    }
  }

  async function saveBaseline() {
    if (ringId == null || !scan) return
    setSaving(true)
    setError(null)
    try {
      const res = await authFetch('/api/network/ring-baseline', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ringId, scan, savedBy: operatorName() }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Save failed')
      setBaseline(data.baseline)
      await runCheck() // re-evaluate against the freshly saved baseline
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (rings.length === 0) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        No ring topology loaded for this subsystem. Pull/seed network data first.
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <Network className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">Ring Commissioning</h2>
        {rings.length > 1 && (
          <select
            value={ringId ?? ''}
            onChange={(e) => setRingId(Number(e.target.value))}
            className="text-sm rounded-md border bg-card px-2 py-1"
          >
            {rings.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={runCheck}
            disabled={running || ringId == null}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border bg-primary text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Scanning switches…' : 'Run Ring Check'}
          </button>
        </div>
      </div>

      {/* Baseline status */}
      <div className="text-xs text-muted-foreground">
        {baseline
          ? <>Baseline saved{baseline.savedBy ? ` by ${baseline.savedBy}` : ''} on {new Date(baseline.savedAt).toLocaleString()} ({baseline.links.length} link{baseline.links.length === 1 ? '' : 's'}).</>
          : <>No baseline saved yet — run a check, verify the observed wiring against the drawing, then <strong>Save as expected baseline</strong>.</>}
      </div>

      {error && (
        <div className="rounded-md border border-red-600/40 bg-red-600/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {report && <ReportBody report={report} scan={scan} saving={saving} onSave={saveBaseline} />}
    </div>
  )
}

function ReportBody({ report, scan, saving, onSave }: {
  report: RingCheckReport; scan: unknown; saving: boolean; onSave: () => void
}) {
  const m = STATE_META[report.overall]
  return (
    <div className="space-y-4">
      {/* Overall banner */}
      <div className={cn('flex items-center gap-3 rounded-lg border px-4 py-3', m.cls)}>
        <m.Icon className="w-6 h-6" />
        <div className="flex-1">
          <div className="font-semibold">Overall: {m.label}</div>
          <div className="text-xs opacity-80">
            {report.summary.pass} pass · {report.summary.fail} fail · {report.summary.warn} warn · {report.summary.skip} review
            {' · '}generated {new Date(report.generatedAt).toLocaleString()}
          </div>
        </div>
      </div>

      {/* Reachability */}
      <div className="flex items-center gap-2 text-sm">
        <StatePill state={report.reachability.state} />
        <span className="text-muted-foreground">{report.reachability.message}</span>
      </div>

      {/* First-run: offer to save baseline */}
      {!report.hasBaseline && scan != null && (
        <div className="rounded-lg border border-amber-600/40 bg-amber-600/10 p-3 space-y-2">
          <div className="text-sm font-medium text-amber-700 dark:text-amber-300">
            First run — no baseline yet
          </div>
          <p className="text-xs text-muted-foreground">
            The observed wiring below is shown for review. Check each ring link against the drawing.
            Only save once it matches — do not save a topology that disagrees with the drawing.
          </p>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border bg-card hover:bg-accent transition disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save as expected baseline
          </button>
        </div>
      )}

      {/* Per-DPM */}
      <div className="grid gap-3 md:grid-cols-2">
        {report.dpms.map((dpm) => <DpmCard key={dpm.dpmName} dpm={dpm} hasBaseline={report.hasBaseline} />)}
      </div>
    </div>
  )
}

function DpmCard({ dpm, hasBaseline }: { dpm: DpmReport; hasBaseline: boolean }) {
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
        <span className="font-mono text-sm font-semibold">{dpm.dpmName}</span>
        <span className="text-xs text-muted-foreground">{dpm.ip}</span>
        <div className="ml-auto"><StatePill state={dpm.ringHealth.state} /></div>
      </div>

      {!dpm.reachable ? (
        <div className="px-3 py-3 text-sm text-muted-foreground">Switch unreachable — not checked.</div>
      ) : (
        <div className="divide-y">
          {/* Ring health */}
          <div className="px-3 py-2 text-xs text-muted-foreground">{dpm.ringHealth.message}</div>

          {/* Links */}
          {dpm.links.length > 0 && (
            <div className="px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Cable className="w-3 h-3" /> {hasBaseline ? 'Topology vs baseline' : 'Observed uplinks'}
              </div>
              {dpm.links.map((l, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <StatePill state={l.state} />
                  <span className="leading-tight">{l.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Terminations */}
          {dpm.terminations.length > 0 && (
            <div className="px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Gauge className="w-3 h-3" /> Termination quality
              </div>
              {dpm.terminations.map((t) => (
                <div key={t.port} className="flex items-start gap-2 text-xs">
                  <StatePill state={t.state} />
                  <span className="leading-tight">{t.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
