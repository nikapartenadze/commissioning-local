"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Loader2, ShieldAlert, Search, X, OctagonX, Play, Square, CheckCircle2, XCircle, RotateCcw, ArrowDown, ShieldCheck, ChevronLeft } from 'lucide-react'
import { authFetch } from '@/lib/api-config'
import { useUser } from '@/lib/user-context'
import { cn } from '@/lib/utils'
import { FailCommentDialog } from '@/components/fail-comment-dialog'

// ── Types ──────────────────────────────────────────────────────────

interface IoPoint {
  tag: string
  value: boolean | null
}

interface Vfd {
  tag: string
  stoTag: string
  stoActive: boolean | null
}

interface RelatedTag {
  tag: string
  value: boolean | null
}

type AutoVerdict = 'ready' | 'pass' | 'fail' | 'unknown'

interface Epc {
  id: number
  name: string
  checkTag: string
  checkTagValue: boolean | null
  ioPoints: IoPoint[]
  mustStopVfds: Vfd[]
  keepRunningVfds: Vfd[]
  mustDropTags?: RelatedTag[]
  mustStayOkTags?: RelatedTag[]
  autoVerdict?: AutoVerdict
  result: 'pass' | 'fail' | null
  comments: string | null
  failureMode: string | null
  testedBy: string | null
  testedAt: string | null
}

interface Zone {
  id: number
  name: string
  epcs: Epc[]
}

interface EStopStatusResponse {
  success: boolean
  connected: boolean
  zones: Zone[]
}

interface EStopCheckViewProps {
  subsystemId?: number
}

// ── Helpers ─────────────────────────────────────────────────────────

function StatusDot({ active, size = 'sm' }: { active: boolean | null; size?: 'sm' | 'md' | 'lg' }) {
  const color =
    active === true ? 'bg-emerald-400 shadow-emerald-400/60'
      : active === false ? 'bg-red-500 shadow-red-500/60'
        : 'bg-gray-500 shadow-gray-500/30'
  const sz = size === 'lg' ? 'w-3.5 h-3.5' : size === 'md' ? 'w-3 h-3' : 'w-2.5 h-2.5'
  return <span className={cn('inline-block rounded-full shadow-sm', sz, color)} />
}

function CheckedPill({ value, size = 'md' }: { value: boolean | null; size?: 'sm' | 'md' }) {
  const isChecked = value === true
  const isNotChecked = value === false
  const cls = size === 'sm'
    ? 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wide border'
    : 'inline-flex items-center gap-2 px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wide border'
  if (isChecked) return (
    <span className={cn(cls, 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/40')}>
      <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-emerald-500/60 shadow-sm" />
      Checked
    </span>
  )
  if (isNotChecked) return (
    <span className={cn(cls, 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/40')}>
      <span className="w-2 h-2 rounded-full bg-red-500 shadow-red-500/60 shadow-sm" />
      Not Checked
    </span>
  )
  return (
    <span className={cn(cls, 'bg-muted text-muted-foreground border-border')}>
      <span className="w-2 h-2 rounded-full bg-gray-400" />
      No Data
    </span>
  )
}

function VfdBadge({ vfd, expectStoActive }: { vfd: Vfd; expectStoActive: boolean }) {
  const isGood = vfd.stoActive !== null && vfd.stoActive === expectStoActive
  const isBad = vfd.stoActive !== null && vfd.stoActive !== expectStoActive

  const bg = isGood
    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
    : isBad
      ? 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30'
      : 'bg-muted text-muted-foreground border-border'

  return (
    <span
      className={cn('inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border', bg)}
      title={`${vfd.stoTag} = ${vfd.stoActive === null ? 'N/A' : vfd.stoActive}`}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full', isGood ? 'bg-emerald-500' : isBad ? 'bg-red-500' : 'bg-gray-400')} />
      {vfd.tag}
    </span>
  )
}

function RelatedTagBadge({ tag, value, expectedTrue }: { tag: string; value: boolean | null; expectedTrue: boolean }) {
  const isPass = value !== null && value === expectedTrue
  const isFail = value !== null && value !== expectedTrue
  const bg = isPass
    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
    : isFail
      ? 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30'
      : 'bg-muted text-muted-foreground border-border'
  const label = value === null
    ? 'WAIT'
    : isPass
      ? (expectedTrue ? 'OK' : 'DROPPED')
      : (expectedTrue ? 'FAULT' : 'NOT DROPPED')
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono rounded-md border', bg)}
      title={`${tag} = ${value === null ? 'N/A' : value}`}
    >
      <span className={cn('w-2 h-2 rounded-full', isPass ? 'bg-emerald-500' : isFail ? 'bg-red-500' : 'bg-gray-400')} />
      {tag}
      <span className="ml-1 text-[10px] font-bold opacity-80">{label}</span>
    </span>
  )
}

// Short EPC label for compact lists inside zone cards — drops the redundant
// ZONE_xx_xx prefix that's already shown by the parent card.
function shortEpcLabel(epcName: string, zoneName: string): string {
  // zoneName looks like "MCM02_ZONE_01_01"; the zone portion is "ZONE_01_01_"
  const zonePart = zoneName.replace(/^MCM\d+_/, '') + '_'
  if (epcName.startsWith(zonePart)) return epcName.slice(zonePart.length)
  return epcName
}

// Zone-level rollup driven by the live _CHECKED tag — green only if all EPCs
// in the zone read true, red if any read false, gray if data is incomplete.
type ZoneStatus = 'all-checked' | 'partial' | 'none-checked' | 'no-data'
function rollupZoneStatus(epcs: Epc[]): ZoneStatus {
  if (epcs.length === 0) return 'no-data'
  const values = epcs.map(e => e.checkTagValue)
  if (values.every(v => v === null)) return 'no-data'
  const known = values.filter((v): v is boolean => v !== null)
  if (known.length === 0) return 'no-data'
  if (known.every(v => v === true)) return 'all-checked'
  if (known.every(v => v === false)) return 'none-checked'
  return 'partial'
}

// ── Main Component ─────────────────────────────────────────────────

export default function EStopCheckView({ subsystemId }: EStopCheckViewProps) {
  const { currentUser, isServerDevice } = useUser()
  const [data, setData] = useState<EStopStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null)
  const [pulling, setPulling] = useState(false)
  const [submittingResult, setSubmittingResult] = useState<{ epcId: number; kind: 'pass' | 'fail' | 'reset' } | null>(null)
  const [resultError, setResultError] = useState<string | null>(null)
  const [failDialogOpen, setFailDialogOpen] = useState(false)
  const [pendingFailEpc, setPendingFailEpc] = useState<{ epc: Epc; zoneName: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastDataRef = useRef<string>('')
  const triedCloudPull = useRef(false)
  const initializedRef = useRef(false)

  useEffect(() => {
    const fetchStatus = async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const url = subsystemId ? `/api/estop/status?subsystemId=${subsystemId}` : '/api/estop/status'
        const res = await authFetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: EStopStatusResponse = await res.json()
        const jsonStr = JSON.stringify(json)
        if (jsonStr !== lastDataRef.current) {
          lastDataRef.current = jsonStr
          setData(json)
        }
        setError(null)
        if (!initializedRef.current && json.zones.length > 0) {
          initializedRef.current = true
          // Auto-select first zone so detail panel is always visible
          setSelectedZoneId(json.zones[0].id)
        }
        // Auto-pull from cloud if no local data (once)
        if (loading && json.zones.length === 0 && !triedCloudPull.current) {
          triedCloudPull.current = true
          try {
            setPulling(true)
            const pullRes = await authFetch('/api/cloud/pull-estop', { method: 'POST' })
            const pullData = await pullRes.json()
            if (pullData.success && pullData.zones > 0) {
              const res2 = await authFetch(url, { signal: controller.signal })
              if (res2.ok) {
                const json2: EStopStatusResponse = await res2.json()
                setData(json2)
                if (json2.zones.length > 0) {
                  setSelectedZoneId(json2.zones[0].id)
                }
              }
            }
          } catch {
            // Cloud pull failed — not an error, just no data
          } finally {
            setPulling(false)
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Failed to fetch')
      }
      setLoading(false)
    }

    fetchStatus()
    const id = setInterval(fetchStatus, 3000)
    return () => { clearInterval(id); abortRef.current?.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsystemId])

  const submitEpcResult = useCallback(async (
    epc: Epc,
    zoneName: string,
    action:
      | { result: 'pass' }
      | { result: 'fail'; failureMode?: string; comments?: string }
      | { reset: true },
  ) => {
    if (!subsystemId) {
      setResultError('Subsystem not selected — cannot record EPC check.')
      return
    }
    const kind: 'pass' | 'fail' | 'reset' = 'reset' in action ? 'reset' : action.result
    setSubmittingResult({ epcId: epc.id, kind })
    setResultError(null)
    try {
      const body: Record<string, unknown> = {
        subsystemId,
        zoneName,
        checkTag: epc.checkTag,
        testedBy: currentUser?.fullName ?? null,
      }
      if ('reset' in action) {
        body.reset = true
      } else {
        body.result = action.result
        if (action.result === 'fail') {
          if (action.failureMode) body.failureMode = action.failureMode
          if (action.comments) body.comments = action.comments
        }
      }
      const res = await authFetch('/api/estop/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null) as { error?: string; reason?: string } | null
        const message = errorBody?.reason === 'server-laptop-no-testing'
          ? 'Server Laptop cannot author test results. Mark from a Client Laptop.'
          : errorBody?.error || `HTTP ${res.status}`
        throw new Error(message)
      }
      setData(prev => prev && {
        ...prev,
        zones: prev.zones.map(z => z.name !== zoneName ? z : {
          ...z,
          epcs: z.epcs.map(e => {
            if (e.checkTag !== epc.checkTag) return e
            if ('reset' in action) {
              return { ...e, result: null, comments: null, failureMode: null, testedBy: null, testedAt: null }
            }
            return {
              ...e,
              result: action.result,
              testedBy: currentUser?.fullName ?? null,
              testedAt: new Date().toISOString(),
              failureMode: action.result === 'fail' ? (action.failureMode ?? null) : null,
              comments: action.result === 'fail' ? (action.comments ?? null) : e.comments,
            }
          }),
        }),
      })
    } catch (err) {
      setResultError(err instanceof Error ? err.message : 'Failed to record result')
    } finally {
      setSubmittingResult(null)
    }
  }, [currentUser?.fullName, subsystemId])

  if (loading || pulling) {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 rounded bg-muted animate-pulse" />
          <div className="h-6 w-64 rounded bg-muted animate-pulse" />
        </div>
        <div className="h-10 rounded bg-muted animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {[1,2,3,4,5,6].map(i => (
            <div key={i} className="h-36 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      </div>
    )
  }
  if (error && !data) {
    return <div className="flex flex-col items-center justify-center h-64 gap-3"><ShieldAlert className="w-10 h-10 text-red-500" /><p className="text-sm text-muted-foreground">{error}</p></div>
  }

  const allZones = data?.zones ?? []
  const connected = data?.connected ?? false
  const search = searchTerm.toLowerCase().trim()

  // Filter zones+EPCs by search
  const zones = search
    ? allZones.map(zone => {
        const matchesZone = zone.name.toLowerCase().includes(search)
        const epcs = matchesZone
          ? zone.epcs
          : zone.epcs.filter(epc =>
              epc.name.toLowerCase().includes(search) ||
              epc.checkTag.toLowerCase().includes(search) ||
              epc.ioPoints.some(io => io.tag.toLowerCase().includes(search)) ||
              epc.mustStopVfds.some(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search)) ||
              epc.keepRunningVfds.some(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search)) ||
              (epc.mustDropTags ?? []).some(r => r.tag.toLowerCase().includes(search)) ||
              (epc.mustStayOkTags ?? []).some(r => r.tag.toLowerCase().includes(search))
            )
        return epcs.length > 0 ? { ...zone, epcs } : null
      }).filter((z): z is Zone => z !== null)
    : allZones

  // Pick selected zone from filtered set; fall back to first visible if the
  // previously selected zone got filtered out.
  const selectedZone: Zone | null = zones.length === 0
    ? null
    : zones.find(z => z.id === selectedZoneId) ?? zones[0]

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <OctagonX className="w-5 h-5 text-red-500" />
          <h2 className="text-lg font-semibold">Emergency Pull Cord Check</h2>
        </div>
        <Badge variant="outline" className={cn('text-xs', connected ? 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400' : 'border-red-500/50 text-red-600 dark:text-red-400')}>
          <span className={cn('w-2 h-2 rounded-full mr-1.5', connected ? 'bg-emerald-500' : 'bg-red-500')} />
          PLC {connected ? 'Connected' : 'Disconnected'}
        </Badge>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search zones, EPCs, VFDs, tags..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full pl-9 pr-8 py-2 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
        {searchTerm && (
          <button onClick={() => setSearchTerm('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {error && data && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-1.5">
          Poll error: {error}
        </div>
      )}

      {/* Zone card grid — annunciator panel: uniform height regardless of EPC count */}
      {zones.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
          <ShieldAlert className="w-8 h-8 mb-2 opacity-50" />
          <p className="text-sm">{search ? 'No matches' : 'No EStop zones configured'}</p>
          {!search && (
            <p className="text-xs text-muted-foreground/60 mt-1">Pull IOs from the config dialog to load EStop data</p>
          )}
        </div>
      ) : (() => {
        // Drive all cards to the same internal slot count so heights are
        // uniform regardless of how many EPCs a zone actually has. Two-column
        // inner grid → rows = ceil(maxEpcs / 2).
        const maxEpcs = Math.max(...zones.map(z => z.epcs.length), 1)
        const innerRows = Math.max(1, Math.ceil(maxEpcs / 2))
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {zones.map(zone => {
              const status = rollupZoneStatus(zone.epcs)
              const checkedCount = zone.epcs.filter(e => e.checkTagValue === true).length
              const isSelected = selectedZone?.id === zone.id
              const stripeColor =
                status === 'all-checked' ? 'bg-emerald-500'
                : status === 'none-checked' ? 'bg-red-500'
                : status === 'partial' ? 'bg-amber-500'
                : 'bg-muted-foreground/30'
              const borderColor =
                status === 'all-checked' ? 'border-emerald-500/30 hover:border-emerald-500/60'
                : status === 'none-checked' ? 'border-red-500/30 hover:border-red-500/60'
                : status === 'partial' ? 'border-amber-500/30 hover:border-amber-500/60'
                : 'border-border hover:border-muted-foreground/40'
              const badgeBg =
                status === 'all-checked' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-emerald-500/30'
                : status === 'none-checked' ? 'bg-red-500/15 text-red-700 dark:text-red-400 ring-red-500/30'
                : status === 'partial' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/30'
                : 'bg-muted text-muted-foreground ring-border'

              // Split "MCM02_ZONE_01_04" → label "MCM02" + body "ZONE_01_04"
              const m = /^([A-Z]+\d+)_(.+)$/.exec(zone.name)
              const mcmLabel = m ? m[1] : ''
              const zoneLabel = m ? m[2] : zone.name

              const padCount = innerRows * 2 - zone.epcs.length

              return (
                <button
                  key={zone.id}
                  onClick={() => setSelectedZoneId(zone.id)}
                  className={cn(
                    'group relative flex flex-col overflow-hidden text-left rounded-lg border bg-card transition-all',
                    'hover:shadow-lg hover:-translate-y-0.5',
                    borderColor,
                    isSelected && 'ring-2 ring-primary shadow-lg -translate-y-0.5',
                  )}
                >
                  {/* Status stripe — annunciator panel cue */}
                  <span aria-hidden className={cn('absolute inset-x-0 top-0 h-0.5', stripeColor)} />

                  {/* Header */}
                  <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2 border-b border-border/60">
                    <div className="min-w-0 flex items-baseline gap-1.5">
                      {mcmLabel && (
                        <span className="text-[10px] font-mono font-semibold uppercase tracking-widest text-muted-foreground/70">
                          {mcmLabel}
                        </span>
                      )}
                      <span className="font-mono font-semibold text-sm tabular-nums tracking-tight truncate">
                        {zoneLabel}
                      </span>
                    </div>
                    <span className={cn(
                      'text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded ring-1 shrink-0',
                      badgeBg,
                    )}>
                      {checkedCount}/{zone.epcs.length}
                    </span>
                  </div>

                  {/* EPC grid — fixed row count drives uniform height */}
                  <div
                    className="grid grid-cols-2 gap-x-2 gap-y-1 px-3 py-2.5 flex-1"
                    style={{ gridTemplateRows: `repeat(${innerRows}, minmax(22px, auto))` }}
                  >
                    {zone.epcs.map(epc => (
                      <div key={epc.id} className="flex items-center gap-1.5 min-w-0">
                        <StatusDot active={epc.checkTagValue} size="md" />
                        <span className="font-mono text-[11px] text-foreground/90 truncate flex-1">
                          {shortEpcLabel(epc.name, zone.name)}
                        </span>
                        {epc.result === 'pass' && (
                          <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" aria-label="Passed" />
                        )}
                        {epc.result === 'fail' && (
                          <XCircle className="w-3 h-3 text-red-500 shrink-0" aria-label="Failed" />
                        )}
                      </div>
                    ))}
                    {/* Empty annunciator slots — render a faded socket to keep
                        the panel grid rhythmic when this zone has fewer EPCs
                        than the largest one. */}
                    {Array.from({ length: padCount }).map((_, i) => (
                      <div key={`pad-${i}`} aria-hidden className="flex items-center gap-1.5 min-w-0 opacity-30">
                        <span className="inline-block w-3 h-3 rounded-full border border-dashed border-muted-foreground/40" />
                        <span className="font-mono text-[11px] text-muted-foreground/40 truncate flex-1">—</span>
                      </div>
                    ))}
                  </div>
                </button>
              )
            })}
          </div>
        )
      })()}

      {/* Selected-zone detail panel */}
      {selectedZone && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-3 pb-2 border-b">
            <ChevronLeft className="w-4 h-4 text-muted-foreground" />
            <h3 className="font-mono font-semibold text-base">{selectedZone.name}</h3>
            <Badge variant="outline" className="text-xs">{selectedZone.epcs.length} EPC{selectedZone.epcs.length !== 1 ? 's' : ''}</Badge>
          </div>

          {selectedZone.epcs.map(epc => {
            const submitting = submittingResult?.epcId === epc.id ? submittingResult.kind : null
            const mustDrop = epc.mustDropTags ?? []
            const mustStayOk = epc.mustStayOkTags ?? []
            // search-filtered sub-lists (only inside the selected zone)
            const detailIo = search ? epc.ioPoints.filter(io => io.tag.toLowerCase().includes(search)) : epc.ioPoints
            const detailMustStop = search ? epc.mustStopVfds.filter(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search)) : epc.mustStopVfds
            const detailKeepRun = search ? epc.keepRunningVfds.filter(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search)) : epc.keepRunningVfds
            const detailMustDrop = search ? mustDrop.filter(r => r.tag.toLowerCase().includes(search)) : mustDrop
            const detailMustStayOk = search ? mustStayOk.filter(r => r.tag.toLowerCase().includes(search)) : mustStayOk
            const anySubMatch = detailIo.length || detailMustStop.length || detailKeepRun.length || detailMustDrop.length || detailMustStayOk.length
            const finalIo = search && !anySubMatch ? epc.ioPoints : detailIo
            const finalMustStop = search && !anySubMatch ? epc.mustStopVfds : detailMustStop
            const finalKeepRun = search && !anySubMatch ? epc.keepRunningVfds : detailKeepRun
            const finalMustDrop = search && !anySubMatch ? mustDrop : detailMustDrop
            const finalMustStayOk = search && !anySubMatch ? mustStayOk : detailMustStayOk

            return (
              <Card key={epc.id}>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b">
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusDot active={epc.checkTagValue} size="lg" />
                    <div className="min-w-0">
                      <h4 className="font-mono font-semibold text-sm truncate">{epc.name}</h4>
                      <p className="text-[11px] text-muted-foreground font-mono truncate">{epc.checkTag}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <CheckedPill value={epc.checkTagValue} />
                    <Button
                      size="sm"
                      variant={epc.result === 'pass' ? 'default' : 'outline'}
                      className={cn(
                        'gap-1',
                        epc.result === 'pass' && 'bg-emerald-600 hover:bg-emerald-700 text-white',
                      )}
                      disabled={isServerDevice || submittingResult !== null}
                      onClick={() => submitEpcResult(epc, selectedZone.name, { result: 'pass' })}
                    >
                      {submitting === 'pass' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      Pass
                    </Button>
                    <Button
                      size="sm"
                      variant={epc.result === 'fail' ? 'default' : 'outline'}
                      className={cn(
                        'gap-1',
                        epc.result === 'fail' && 'bg-red-600 hover:bg-red-700 text-white',
                      )}
                      disabled={isServerDevice || submittingResult !== null}
                      onClick={() => {
                        setPendingFailEpc({ epc, zoneName: selectedZone.name })
                        setFailDialogOpen(true)
                      }}
                    >
                      {submitting === 'fail' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                      Fail
                    </Button>
                    {epc.result && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1 text-muted-foreground"
                        disabled={isServerDevice || submittingResult !== null}
                        onClick={() => submitEpcResult(epc, selectedZone.name, { reset: true })}
                        title="Clear this result"
                      >
                        {submitting === 'reset' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                      </Button>
                    )}
                  </div>
                </div>

                <CardContent className="p-4 space-y-5">
                  {epc.testedBy && (
                    <p className="text-xs text-muted-foreground">
                      Manually marked <span className="font-semibold">{epc.result === 'pass' ? 'Pass' : 'Fail'}</span>
                      {' '}by <span className="font-medium">{epc.testedBy}</span>
                      {epc.testedAt && <> · {new Date(epc.testedAt).toLocaleString()}</>}
                    </p>
                  )}
                  {resultError && submittingResult === null && (
                    <p className="text-xs text-red-600 dark:text-red-400">{resultError}</p>
                  )}
                  {isServerDevice && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Server Laptop cannot author test results — open this view on a Client Laptop to record pass/fail.
                    </p>
                  )}

                  {/* IO Points */}
                  {finalIo.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">IO Points (Normally Closed)</p>
                      <div className="flex flex-wrap gap-2">
                        {finalIo.map(io => (
                          <span
                            key={io.tag}
                            className={cn(
                              'inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono rounded-md border',
                              io.value === true ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                                : io.value === false ? 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30'
                                  : 'bg-muted text-muted-foreground border-border'
                            )}
                          >
                            <span className={cn('w-2 h-2 rounded-full', io.value === true ? 'bg-emerald-500' : io.value === false ? 'bg-red-500' : 'bg-gray-400')} />
                            {io.tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {finalMustDrop.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <ArrowDown className="w-3.5 h-3.5 text-red-500" />
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Other ESTOPs — Must Drop <span className="normal-case opacity-60">({finalMustDrop.length})</span>
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {finalMustDrop.map(r => (
                          <RelatedTagBadge key={r.tag} tag={r.tag} value={r.value} expectedTrue={false} />
                        ))}
                      </div>
                    </div>
                  )}

                  {finalMustStop.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <Square className="w-3.5 h-3.5 text-red-500" />
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          VFDs — Must Stop <span className="normal-case opacity-60">({finalMustStop.length})</span>
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {finalMustStop.map(vfd => (
                          <VfdBadge key={vfd.tag} vfd={vfd} expectStoActive={true} />
                        ))}
                      </div>
                    </div>
                  )}

                  {finalMustStayOk.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Other ESTOPs — Must Stay OK <span className="normal-case opacity-60">({finalMustStayOk.length})</span>
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {finalMustStayOk.map(r => (
                          <RelatedTagBadge key={r.tag} tag={r.tag} value={r.value} expectedTrue={true} />
                        ))}
                      </div>
                    </div>
                  )}

                  {finalKeepRun.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <Play className="w-3.5 h-3.5 text-emerald-500" />
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          VFDs — Keep Running <span className="normal-case opacity-60">({finalKeepRun.length})</span>
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {finalKeepRun.map(vfd => (
                          <VfdBadge key={vfd.tag} vfd={vfd} expectStoActive={false} />
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <FailCommentDialog
        open={failDialogOpen}
        onOpenChange={(open) => {
          setFailDialogOpen(open)
          if (!open) setPendingFailEpc(null)
        }}
        io={
          pendingFailEpc
            ? {
                name: pendingFailEpc.epc.name,
                description: pendingFailEpc.epc.checkTag,
                tagType: 'EPC',
              }
            : null
        }
        onSubmit={(_io, comment, failureMode) => {
          if (!pendingFailEpc) return
          submitEpcResult(pendingFailEpc.epc, pendingFailEpc.zoneName, {
            result: 'fail',
            failureMode,
            comments: comment || undefined,
          })
          setPendingFailEpc(null)
        }}
        onCancel={() => setPendingFailEpc(null)}
      />
    </div>
  )
}
