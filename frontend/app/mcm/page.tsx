import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Cpu, Wifi, WifiOff, PlugZap, Plug, Power, Download, Settings, Users,
  DownloadCloud, Search, Loader2, Network, Hash, Tag, ArrowUpRight,
  Save, CheckCircle2, XCircle, AlertTriangle, UploadCloud, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ThemeToggle } from '@/components/theme-toggle'
import { AutstandLogo } from '@/components/autstand-logo'
import { ControllerConsole } from '@/components/controller-console'
import { BatchUploadDialog } from '@/components/batch-upload-dialog'
import { useUser } from '@/lib/user-context'
import { authFetch } from '@/lib/api-config'

function useCanConfigure(): boolean {
  const { authRequired, currentUser } = useUser()
  if (!authRequired) return true
  return currentUser?.isAdmin === true
}

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
type McmStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'disconnected'

const POLL_MS = 2000

interface Tone { label: string; dot: string; chip: string; pulse: boolean }
function statusTone(m: McmRow): Tone {
  if (!m.ip) return { label: 'No IP', dot: 'bg-muted-foreground/50', chip: 'border-border bg-muted text-muted-foreground', pulse: false }
  switch (m.status) {
    case 'connected': return { label: 'Online', dot: 'bg-success', chip: 'border-success/40 bg-success/10 text-success', pulse: true }
    case 'connecting':
    case 'reconnecting': return { label: 'Connecting', dot: 'bg-warning', chip: 'border-warning/40 bg-warning/10 text-warning', pulse: true }
    case 'error': return { label: 'Error', dot: 'bg-destructive', chip: 'border-destructive/40 bg-destructive/10 text-destructive', pulse: false }
    default: return { label: 'Offline', dot: 'bg-muted-foreground/50', chip: 'border-border bg-muted text-muted-foreground', pulse: false }
  }
}

export default function McmLandingPage() {
  const canConfigure = useCanConfigure()
  const [mcms, setMcms] = useState<McmRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [fleetBusy, setFleetBusy] = useState<'connect' | 'disconnect' | 'import' | null>(null)
  const [fleetMsg, setFleetMsg] = useState<string | null>(null)
  const [uploadAllOpen, setUploadAllOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch('/api/mcm')
      const data = await r.json()
      if (data && Array.isArray(data.mcms)) { setMcms(data.mcms as McmRow[]); setError(null) }
      else if (data?.error) setError(String(data.error))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    refresh()
    const poll = setInterval(refresh, POLL_MS)
    return () => clearInterval(poll)
  }, [refresh])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? mcms.filter((m) => m.name.toLowerCase().includes(q) || m.subsystemId.toLowerCase().includes(q) || m.ip?.includes(q)) : mcms
  }, [mcms, filter])
  const online = mcms.filter((m) => m.connected).length

  const fleet = useCallback(async (kind: 'connect' | 'disconnect' | 'import') => {
    setFleetBusy(kind); setFleetMsg(null)
    try {
      const url = kind === 'import' ? '/api/mcm/import-from-cloud' : `/api/mcm/${kind}-all`
      const r = await authFetch(url, { method: 'POST' })
      const d = await r.json()
      if (d?.success) setFleetMsg(kind === 'import' ? `Imported ${d.total ?? 0} station(s)` : kind === 'connect' ? `Connected ${d.connected}/${d.total}` : `Disconnected ${d.disconnected}/${d.total}`)
      else setFleetMsg(d?.error || `${kind} failed`)
      await refresh()
    } catch (e) { setFleetMsg(e instanceof Error ? e.message : String(e)) }
    finally { setFleetBusy(null) }
  }, [refresh])

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* ───────── Header ───────── */}
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center gap-4">
          <AutstandLogo className="h-5 sm:h-6 shrink-0" />
          <div className="h-6 w-px bg-border hidden sm:block" />
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight leading-none">Central Control</h1>
            <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              {online}/{mcms.length} controllers online
            </p>
          </div>
          <div className="flex-1" />
          <div className="relative hidden md:block">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search controllers…"
              className="w-48 lg:w-64 pl-8 pr-2 py-2 text-sm rounded-md bg-muted border border-transparent focus:border-primary focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring/30 placeholder:text-muted-foreground" />
          </div>
          {canConfigure && (
            <div className="hidden sm:flex items-center gap-2">
              <Button onClick={() => fleet('connect')} disabled={!!fleetBusy} size="sm" className="gap-1.5">
                {fleetBusy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}<span className="hidden lg:inline">Connect all</span>
              </Button>
              <Button onClick={() => fleet('disconnect')} disabled={!!fleetBusy} size="sm" variant="outline" className="gap-1.5">
                {fleetBusy === 'disconnect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}<span className="hidden lg:inline">Stop all</span>
              </Button>
              <Button onClick={() => setUploadAllOpen(true)} disabled={!!fleetBusy} size="sm" variant="outline" className="gap-1.5" title="Upload program from multiple controllers">
                <UploadCloud className="h-4 w-4" /><span className="hidden lg:inline">Upload all</span>
              </Button>
              <Button onClick={() => fleet('import')} disabled={!!fleetBusy} size="sm" variant="ghost" className="gap-1.5">
                {fleetBusy === 'import' ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}<span className="hidden lg:inline">Import</span>
              </Button>
            </div>
          )}
          <div className="flex items-center gap-0.5 border-l border-border pl-2 ml-1">
            <Button asChild size="icon" variant="ghost" title="Firmware compliance"><a href="/firmware"><ShieldCheck className="h-4 w-4" /></a></Button>
            {canConfigure && (
              <>
                <Button asChild size="icon" variant="ghost" title="Accounts"><a href="/settings/users"><Users className="h-4 w-4" /></a></Button>
                <Button asChild size="icon" variant="ghost" title="Configure"><a href="/settings/mcms"><Settings className="h-4 w-4" /></a></Button>
              </>
            )}
          </div>
          <ThemeToggle />
        </div>
        {fleetMsg && <div className="mx-auto max-w-7xl px-6 pb-2 -mt-1"><p className="text-xs text-muted-foreground">{fleetMsg}</p></div>}
      </header>

      {/* mobile search */}
      <div className="md:hidden border-b border-border bg-card p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search controllers…"
            className="w-full pl-8 pr-2 py-2 text-sm rounded-md bg-muted border border-input focus:border-primary focus:outline-none placeholder:text-muted-foreground" />
        </div>
      </div>

      {/* ───────── Grid ───────── */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
        {loading ? (
          <div className="grid place-items-center py-24 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin mr-2" />Loading controllers…</div>
        ) : mcms.length === 0 ? (
          <EmptyState canConfigure={canConfigure} onImport={() => fleet('import')} busy={fleetBusy === 'import'} msg={fleetMsg} />
        ) : !filtered.length ? (
          <div className="text-center py-24 text-muted-foreground">No controllers match “{filter}”.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {filtered.map((m) => <McmCard key={m.subsystemId} mcm={m} canConfigure={canConfigure} onChanged={refresh} />)}
          </div>
        )}
      </main>

      {canConfigure && (
        <BatchUploadDialog
          mcms={mcms.map((m) => ({ subsystemId: m.subsystemId, name: m.name, ip: m.ip, path: m.path, connected: m.connected }))}
          open={uploadAllOpen}
          onOpenChange={setUploadAllOpen}
        />
      )}
    </div>
  )
}

// ── MCM card ─────────────────────────────────────────────────────────────────
function McmCard({ mcm, canConfigure, onChanged }: { mcm: McmRow; canConfigure: boolean; onChanged: () => void }) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const t = statusTone(mcm)

  const action = useCallback(async (kind: 'connect' | 'disconnect') => {
    setBusy(kind); setErr(null)
    try {
      const r = await authFetch(`/api/mcm/${mcm.subsystemId}/plc/${kind}`, { method: 'POST', body: '{}' })
      const d = await r.json()
      if (!d.success) setErr(d.error || `${kind} failed`)
      await onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }, [mcm.subsystemId, onChanged])

  return (
    <Card className="bg-card border-border flex flex-col transition-colors hover:border-primary/40">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-lg text-primary truncate">{mcm.name}</CardTitle>
            <p className="text-xs font-mono text-muted-foreground mt-0.5">#{mcm.subsystemId}</p>
          </div>
          <Badge variant="outline" className={cn('shrink-0 gap-1.5 font-semibold', t.chip)}>
            <span className={cn('h-1.5 w-1.5 rounded-full', t.dot, t.pulse && 'animate-pulse')} />{t.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-4">
        <div className="space-y-2">
          <InfoTile label="IP address" value={mcm.ip || '—'} Icon={Network} />
          <div className="grid grid-cols-2 gap-2">
            <InfoTile label="Path" value={mcm.path || '—'} Icon={Hash} />
            <InfoTile label="Live tags" value={mcm.tagCount > 0 ? String(mcm.tagCount) : '—'} Icon={Tag} />
          </div>
        </div>

        {err && <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"><XCircle className="h-3.5 w-3.5 shrink-0" />{err}</div>}

        <div className="mt-auto space-y-2">
          <div className="flex gap-2">
            {mcm.connected ? (
              <Button onClick={() => action('disconnect')} disabled={!!busy || !canConfigure} variant="outline" className="flex-1 gap-1.5 hover:border-destructive/40 hover:text-destructive">
                {busy === 'disconnect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}Disconnect
              </Button>
            ) : (
              <Button onClick={() => action('connect')} disabled={!!busy || !canConfigure || !mcm.ip} className="flex-1 gap-1.5">
                {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}Connect
              </Button>
            )}
            {canConfigure && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" className="gap-1.5" title="Program / download"><Download className="h-4 w-4" /><span className="hidden sm:inline">Program</span></Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2"><Download className="h-5 w-5 text-primary" />Program — {mcm.name}</DialogTitle>
                  </DialogHeader>
                  <ControllerConsole mcm={{ subsystemId: mcm.subsystemId, name: mcm.name, ip: mcm.ip, path: mcm.path }} />
                </DialogContent>
              </Dialog>
            )}
          </div>
          <div className="flex gap-2">
            {canConfigure && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" className="flex-1 gap-1.5"><Settings className="h-4 w-4" />Configure</Button>
                </DialogTrigger>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2"><Settings className="h-5 w-5 text-primary" />Configure — {mcm.name}</DialogTitle>
                  </DialogHeader>
                  <ConfigForm mcm={mcm} onSaved={onChanged} />
                </DialogContent>
              </Dialog>
            )}
            <Button onClick={() => navigate(`/commissioning/${mcm.subsystemId}`)} variant="outline" className="flex-1 gap-1.5">
              Open<ArrowUpRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function InfoTile({ label, value, Icon }: { label: string; value: string; Icon: any }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><Icon className="h-3 w-3" />{label}</div>
      <div className="mt-1 text-sm font-mono font-semibold truncate">{value}</div>
    </div>
  )
}

// ── Config dialog form ───────────────────────────────────────────────────────
function ConfigForm({ mcm, onSaved }: { mcm: McmRow; onSaved: () => void }) {
  const [ip, setIp] = useState(mcm.ip || '')
  const [path, setPath] = useState(mcm.path || '1,0')
  const [busy, setBusy] = useState<'save' | 'connect' | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save(thenConnect: boolean) {
    if (!ip.trim()) { setMsg({ ok: false, text: 'Enter an IP address' }); return }
    setBusy(thenConnect ? 'connect' : 'save'); setMsg(null)
    try {
      const r = await authFetch(`/api/mcm/${mcm.subsystemId}`, { method: 'PUT', body: JSON.stringify({ ip: ip.trim(), path: path.trim() || '1,0' }) })
      const d = await r.json()
      if (!d.success) { setMsg({ ok: false, text: d.error || 'Save failed' }); return }
      if (thenConnect) {
        const c = await authFetch(`/api/mcm/${mcm.subsystemId}/plc/connect`, { method: 'POST', body: '{}' })
        const cd = await c.json()
        if (!cd.success) { setMsg({ ok: false, text: cd.error || 'Connect failed' }); await onSaved(); return }
      }
      setMsg({ ok: true, text: thenConnect ? 'Saved & connected' : 'Saved' })
      await onSaved()
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(null) }
  }

  const fld = 'w-full bg-background border border-input rounded-md px-3 py-2.5 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary'
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">EtherNet/IP address and backplane route to this controller's CPU. “Save &amp; Connect” pulls this station's I/O from the cloud, then connects.</p>
      <div className="grid grid-cols-3 gap-3">
        <label className="col-span-2 space-y-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">IP address</span>
          <input autoFocus value={ip} onChange={(e) => setIp(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save(true)} placeholder="192.168.5.107" className={fld} />
        </label>
        <label className="space-y-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Path</span>
          <input value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save(true)} placeholder="1,0" className={fld} />
        </label>
      </div>
      {msg && (
        <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-sm', msg.ok ? 'border-success/40 bg-success/10 text-success' : 'border-destructive/40 bg-destructive/10 text-destructive')}>
          {msg.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}{msg.text}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={() => save(false)} disabled={!!busy} variant="outline" className="gap-1.5">
          <Save className="h-4 w-4" />{busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        <Button onClick={() => save(true)} disabled={!!busy} className="gap-1.5">
          <PlugZap className="h-4 w-4" />{busy === 'connect' ? 'Connecting…' : 'Save & Connect'}
        </Button>
      </div>
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ canConfigure, onImport, busy, msg }: { canConfigure: boolean; onImport: () => void; busy: boolean; msg: string | null }) {
  return (
    <div className="grid place-items-center py-20">
      <Card className="max-w-md w-full bg-card border-border text-center">
        <CardContent className="pt-8 pb-8">
          <div className="mx-auto grid place-items-center h-16 w-16 rounded-lg bg-primary/10 ring-1 ring-primary/30 mb-4"><Cpu className="h-8 w-8 text-primary" /></div>
          <h2 className="text-lg font-bold">No controllers yet</h2>
          <p className="text-sm text-muted-foreground mt-1.5 px-4">Pull your MCM stations from the cloud to start connecting, configuring, and programming them.</p>
          {canConfigure ? (
            <div className="mt-5 px-6 space-y-2">
              <Button onClick={onImport} disabled={busy} className="w-full gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />}Import from cloud
              </Button>
              <Button asChild variant="ghost" className="w-full gap-1.5 text-muted-foreground"><a href="/settings/mcms"><Settings className="h-3.5 w-3.5" />Configure connection &amp; API key</a></Button>
              {msg && <p className="text-xs text-warning flex items-center justify-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" />{msg}</p>}
            </div>
          ) : <p className="mt-4 text-xs text-muted-foreground">Ask an administrator to import controllers.</p>}
        </CardContent>
      </Card>
    </div>
  )
}
