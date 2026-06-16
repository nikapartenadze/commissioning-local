import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, ShieldCheck, ShieldAlert, HelpCircle, WifiOff, Cpu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/theme-toggle'
import { authFetch } from '@/lib/api-config'
import { Button } from '@/components/ui/button'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'

/**
 * Firmware compliance inventory.
 *
 * Reads the live firmware revision off every reachable CIP device (controller +
 * discovered modules) and checks each against the cloud-curated approved-version
 * baseline (minimum-version rule). Read-only visibility + per-device compliance
 * badges; lives at /firmware. The Scan button drives POST /api/firmware/scan
 * (which also refreshes the baseline); on mount we show the last scan via GET.
 *
 * See docs/superpowers/specs/2026-06-16-firmware-compliance-design.md.
 */

type Verdict = 'compliant' | 'non_compliant' | 'no_baseline' | 'unreachable'

interface DeviceRow {
  label: string
  source: string
  modelName: string | null
  liveRevision: string | null
  approvedMin: string | null
  vendorId: number | null
  productCode: number | null
  serial: number | null
  verdict: Verdict
}

interface ScanResult {
  scannedAt: number
  connected: boolean
  baselineAvailable: boolean
  baselineSyncedAt: number | null
  devices: DeviceRow[]
  error?: string
  baselineSync?: { ok: boolean; count?: number; error?: string }
}

const VERDICT_META: Record<Verdict, { label: string; cls: string; Icon: typeof ShieldCheck }> = {
  compliant: { label: 'Compliant', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', Icon: ShieldCheck },
  non_compliant: { label: 'Non-compliant', cls: 'bg-red-500/15 text-red-600 dark:text-red-400', Icon: ShieldAlert },
  no_baseline: { label: 'No baseline', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', Icon: HelpCircle },
  unreachable: { label: 'Unreachable', cls: 'bg-muted text-muted-foreground', Icon: WifiOff },
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const { label, cls, Icon } = VERDICT_META[verdict]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', cls)}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  )
}

function fmtTime(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleTimeString()
}

export default function FirmwarePage() {
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [onlyIssues, setOnlyIssues] = useState(false)

  const loadLast = useCallback(async () => {
    try {
      const r = await authFetch('/api/firmware')
      const data = await r.json()
      setScan(data?.scan ?? null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadLast() }, [loadLast])

  const runScan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      const r = await authFetch('/api/firmware/scan', { method: 'POST' })
      const data = (await r.json()) as ScanResult
      setScan(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }, [])

  const devices = scan?.devices ?? []
  const shown = onlyIssues ? devices.filter((d) => d.verdict === 'non_compliant') : devices
  const counts = devices.reduce<Record<Verdict, number>>((acc, d) => {
    acc[d.verdict] = (acc[d.verdict] ?? 0) + 1
    return acc
  }, { compliant: 0, non_compliant: 0, no_baseline: 0, unreachable: 0 })

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <Link to="/mcm" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Cpu className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Firmware Compliance</h1>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={runScan} disabled={scanning} size="sm">
            <RefreshCw className={cn('mr-2 h-4 w-4', scanning && 'animate-spin')} />
            {scanning ? 'Scanning…' : 'Scan'}
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {error && (
          <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Status strip */}
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <span>Last scan: <span className="text-foreground">{fmtTime(scan?.scannedAt ?? null)}</span></span>
          {scan && !scan.connected && (
            <span className="text-amber-600 dark:text-amber-400">PLC not connected — connect to scan.</span>
          )}
          {scan && scan.connected && !scan.baselineAvailable && (
            <span className="text-amber-600 dark:text-amber-400">
              No approved-firmware baseline synced yet — showing live versions only.
            </span>
          )}
          {scan?.baselineSync && !scan.baselineSync.ok && (
            <span className="text-amber-600 dark:text-amber-400">
              Baseline not refreshed ({scan.baselineSync.error}); using cached.
            </span>
          )}
          {devices.length > 0 && (
            <span className="flex items-center gap-3">
              <span className="text-emerald-600 dark:text-emerald-400">{counts.compliant} compliant</span>
              <span className="text-red-600 dark:text-red-400">{counts.non_compliant} non-compliant</span>
              <span className="text-amber-600 dark:text-amber-400">{counts.no_baseline} no baseline</span>
            </span>
          )}
          {devices.length > 0 && (
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-foreground">
              <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
              Show non-compliant only
            </label>
          )}
        </div>

        {loading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : devices.length === 0 ? (
          <div className="rounded-lg border border-dashed py-16 text-center text-muted-foreground">
            <Cpu className="mx-auto mb-3 h-8 w-8 opacity-40" />
            <p>No firmware scan yet.</p>
            <p className="text-sm">Click <span className="font-medium text-foreground">Scan</span> to read device firmware and check compliance.</p>
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Live</TableHead>
                  <TableHead>Approved min</TableHead>
                  <TableHead>Compliance</TableHead>
                  <TableHead>Serial</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((d) => (
                  <TableRow key={d.source}>
                    <TableCell className="font-medium">{d.label}</TableCell>
                    <TableCell>{d.modelName ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{d.liveRevision ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{d.approvedMin ?? '—'}</TableCell>
                    <TableCell><VerdictBadge verdict={d.verdict} /></TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {d.serial != null ? d.serial.toString(16).toUpperCase() : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{d.source}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </main>
    </div>
  )
}
