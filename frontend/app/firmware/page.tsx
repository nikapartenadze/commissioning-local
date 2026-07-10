import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ShieldCheck, ArrowLeft, RefreshCw, Loader2, Cpu, CheckCircle2,
  XCircle, AlertTriangle, HelpCircle, CircleSlash,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { AutstandLogo } from '@/components/autstand-logo'
import { authFetch } from '@/lib/api-config'
import { displayVerdict, type DisplayVerdict } from '@/lib/plc/identity/compliance'

/**
 * Standalone firmware-compliance inventory page (field tool).
 *
 * The compliance verdicts also surface as chips inside the Network Diagnostics
 * modal, but that's buried behind the topology page's "Diagnostics" button —
 * an operator can't tell firmware checking exists. This is the dedicated,
 * nav-linked surface promised in the phase-1 design
 * (docs/superpowers/specs/2026-06-16-firmware-compliance-design.md): a full
 * device inventory with live revision vs approved minimum, a verdict badge per
 * device, a "non-compliant only" filter, and an on-demand Scan button.
 *
 * Data comes from the existing endpoints — no new backend:
 *   - GET  /api/firmware       → last cached scan (no PLC touch)
 *   - POST /api/firmware/scan  → refresh baseline from cloud, re-read, re-judge
 */

type Verdict = 'compliant' | 'non_compliant' | 'no_baseline' | 'unreachable'

interface DeviceResult {
  label: string
  source: string
  modelName: string | null
  liveRevision: string | null
  approvedMin: string | null
  vendorId: number | null
  productCode: number | null
  serial: number | null
  verdict: Verdict
  subsystemId?: string
}

interface ScanResult {
  scannedAt: number
  connected: boolean
  baselineAvailable: boolean
  baselineSyncedAt: number | null
  devices: DeviceResult[]
  controllers?: DeviceResult[]
  error?: string
}

const VERDICT_META: Record<DisplayVerdict, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  compliant: { label: 'Compliant', cls: 'border-success/40 bg-success/10 text-success', Icon: CheckCircle2 },
  // Satisfies the minimum but runs a DIFFERENT revision than approved (newer
  // than the project was engineered against) — shown, never silently green.
  mismatch: { label: 'Differs from approved', cls: 'border-warning/40 bg-warning/10 text-warning', Icon: AlertTriangle },
  non_compliant: { label: 'Below minimum', cls: 'border-destructive/40 bg-destructive/10 text-destructive', Icon: XCircle },
  no_baseline: { label: 'No baseline', cls: 'border-warning/40 bg-warning/10 text-warning', Icon: HelpCircle },
  unreachable: { label: 'Unreachable', cls: 'border-border bg-muted text-muted-foreground', Icon: CircleSlash },
}

function VerdictBadge({ verdict }: { verdict: DisplayVerdict }) {
  const m = VERDICT_META[verdict]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold', m.cls)}>
      <m.Icon className="h-3.5 w-3.5 shrink-0" />
      {m.label}
    </span>
  )
}

function timeAgo(ts: number | null): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

export default function FirmwarePage() {
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonCompliantOnly, setNonCompliantOnly] = useState(false)

  // Load the last cached scan on mount (read-only; no PLC touch).
  useEffect(() => {
    let cancelled = false
    authFetch('/api/firmware')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setScan(d?.scan ?? null) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const runScan = useCallback(async () => {
    setScanning(true); setError(null)
    try {
      const r = await authFetch('/api/firmware/scan', { method: 'POST', body: '{}' })
      const d = await r.json()
      setScan(d ?? null)
      if (d?.error) setError(String(d.error))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }, [])

  // Controllers lead the list (the PLC is the most important firmware), then
  // networked devices. On a single-MCM tablet the sole controller is devices[0]
  // already, so only prepend the separate controllers[] when present (central).
  const allRows = useMemo<DeviceResult[]>(() => {
    if (!scan) return []
    return scan.controllers ? [...scan.controllers, ...scan.devices] : scan.devices
  }, [scan])

  // "Issues" = below minimum OR revision differs from approved (mismatch).
  const rows = useMemo(
    () => (nonCompliantOnly
      ? allRows.filter((d) => displayVerdict(d.verdict, d.liveRevision, d.approvedMin) !== 'compliant'
          && d.verdict !== 'no_baseline' && d.verdict !== 'unreachable')
      : allRows),
    [allRows, nonCompliantOnly],
  )

  const counts = useMemo(() => {
    const c = { compliant: 0, mismatch: 0, non_compliant: 0, no_baseline: 0, unreachable: 0 }
    for (const d of allRows) c[displayVerdict(d.verdict, d.liveRevision, d.approvedMin)]++
    return c
  }, [allRows])

  const hasSubsystems = useMemo(() => allRows.some((d) => d.subsystemId != null), [allRows])

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* ───────── Header ───────── */}
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center gap-4">
          <AutstandLogo className="h-5 sm:h-6 shrink-0" />
          <div className="h-6 w-px bg-border hidden sm:block" />
          <div className="min-w-0 flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary shrink-0" />
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-tight leading-none">Firmware Compliance</h1>
              <p className="text-[11px] text-muted-foreground mt-1">
                {scan?.connected
                  ? `${allRows.length} device${allRows.length === 1 ? '' : 's'} · scanned ${timeAgo(scan.scannedAt)}`
                  : 'Not scanned'}
              </p>
            </div>
          </div>
          <div className="flex-1" />
          <Button onClick={runScan} disabled={scanning} size="sm" className="gap-1.5">
            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="hidden sm:inline">{scanning ? 'Scanning…' : 'Scan now'}</span>
          </Button>
          <Button asChild size="icon" variant="ghost" title="Back to controllers"><a href="/mcm"><ArrowLeft className="h-4 w-4" /></a></Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-5">
        {/* Baseline / connection notices */}
        {scan && !scan.baselineAvailable && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">No approved-firmware baseline cached</p>
              <p className="text-warning/80 text-xs mt-0.5">Live revisions are shown, but compliance can't be judged until the baseline syncs from the cloud. Connect to the cloud and Scan again.</p>
            </div>
          </div>
        )}
        {scan?.error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <XCircle className="h-4 w-4 shrink-0" />{scan.error}
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <XCircle className="h-4 w-4 shrink-0" />{error}
          </div>
        )}

        {/* Summary chips */}
        {scan?.connected && allRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <SummaryChip n={counts.compliant} verdict="compliant" />
            <SummaryChip n={counts.mismatch} verdict="mismatch" />
            <SummaryChip n={counts.non_compliant} verdict="non_compliant" />
            <SummaryChip n={counts.no_baseline} verdict="no_baseline" />
            <SummaryChip n={counts.unreachable} verdict="unreachable" />
            <div className="flex-1" />
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <input type="checkbox" checked={nonCompliantOnly} onChange={(e) => setNonCompliantOnly(e.target.checked)} className="accent-destructive" />
              Show issues only
            </label>
          </div>
        )}

        {/* Content states */}
        {loading ? (
          <div className="grid place-items-center py-24 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin mr-2" />Loading…</div>
        ) : !scan ? (
          <EmptyState onScan={runScan} scanning={scanning} />
        ) : !scan.connected ? (
          <div className="grid place-items-center py-20 text-center">
            <Cpu className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground max-w-sm">{scan.error || 'PLC not connected. Connect a controller, then Scan.'}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground text-sm">
            {nonCompliantOnly ? 'No firmware issues — every device matches the approved baseline. 🎉' : 'No devices found in this scan.'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Device</th>
                  {hasSubsystems && <th className="px-3 py-2 font-semibold">MCM</th>}
                  <th className="px-3 py-2 font-semibold">Model</th>
                  <th className="px-3 py-2 font-semibold text-right">Live rev</th>
                  <th className="px-3 py-2 font-semibold text-right">Approved min</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold text-right">Serial</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d, i) => (
                  <tr key={`${d.source}-${d.label}-${i}`} className="border-b border-border/60 last:border-0 hover:bg-accent/30">
                    <td className="px-3 py-2 font-mono font-semibold">{d.label}</td>
                    {hasSubsystems && <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{d.subsystemId ?? '—'}</td>}
                    <td className="px-3 py-2 text-muted-foreground">{d.modelName || '—'}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{d.liveRevision ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{d.approvedMin ?? '—'}</td>
                    <td className="px-3 py-2"><VerdictBadge verdict={displayVerdict(d.verdict, d.liveRevision, d.approvedMin)} /></td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground tabular-nums">{d.serial ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {scan?.baselineSyncedAt != null && (
          <p className="text-[11px] text-muted-foreground">Baseline last synced from cloud {timeAgo(scan.baselineSyncedAt)}.</p>
        )}
      </main>
    </div>
  )
}

function SummaryChip({ n, verdict }: { n: number; verdict: DisplayVerdict }) {
  const m = VERDICT_META[verdict]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold', n === 0 ? 'border-border bg-muted/40 text-muted-foreground' : m.cls)}>
      <m.Icon className="h-3.5 w-3.5 shrink-0" />
      {n} {m.label}
    </span>
  )
}

function EmptyState({ onScan, scanning }: { onScan: () => void; scanning: boolean }) {
  return (
    <div className="grid place-items-center py-20">
      <div className="max-w-md w-full text-center">
        <div className="mx-auto grid place-items-center h-16 w-16 rounded-lg bg-primary/10 ring-1 ring-primary/30 mb-4"><ShieldCheck className="h-8 w-8 text-primary" /></div>
        <h2 className="text-lg font-bold">Check firmware compliance</h2>
        <p className="text-sm text-muted-foreground mt-1.5 px-4">Read the firmware revision of the controller and every networked device, and check each against the cloud-approved minimum supported version.</p>
        <Button onClick={onScan} disabled={scanning} className="mt-5 gap-2">
          {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{scanning ? 'Scanning…' : 'Run scan'}
        </Button>
      </div>
    </div>
  )
}
