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

type CheckType = 'preliminary' | 'final'

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
  // Split live auto-suggested verdicts (positive zone-stop vs negative selectivity).
  preliminaryVerdict?: AutoVerdict
  finalVerdict?: AutoVerdict
  // Recorded results per check type.
  preliminaryResult: 'pass' | 'fail' | null
  preliminaryComments: string | null
  preliminaryFailureMode: string | null
  preliminaryTestedBy: string | null
  preliminaryTestedAt: string | null
  finalResult: 'pass' | 'fail' | null
  finalComments: string | null
  finalFailureMode: string | null
  finalTestedBy: string | null
  finalTestedAt: string | null
}

interface Zone {
  id: number
  name: string
  /** PLC tag `<zone.name>_Nominal_OK`. True = healthy, false = faulted, null = no data. */
  nominalOk?: boolean | null
  nominalOkTag?: string
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

// Compact per-check result chip for the zone-card grid — letter ("P"/"F" for
// the check type) + colored icon. Lets both Preliminary and Final results show
// side-by-side at a glance. Renders nothing when the check has no result yet.
function MiniResultChip({ label, result }: { label: string; result: 'pass' | 'fail' | null }) {
  if (!result) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 shrink-0 text-[9px] font-bold',
        result === 'pass' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
      )}
      title={`${label === 'P' ? 'Preliminary' : 'Final'}: ${result === 'pass' ? 'Passed' : 'Failed'}`}
    >
      {label}
      {result === 'pass'
        ? <CheckCircle2 className="w-3 h-3" aria-label="Passed" />
        : <XCircle className="w-3 h-3" aria-label="Failed" />}
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
  const [submittingResult, setSubmittingResult] = useState<{ epcId: number; checkType: CheckType; kind: 'pass' | 'fail' | 'reset' } | null>(null)
  const [resultError, setResultError] = useState<string | null>(null)
  const [failDialogOpen, setFailDialogOpen] = useState(false)
  const [pendingFailEpc, setPendingFailEpc] = useState<{ epc: Epc; zoneName: string; checkType: CheckType } | null>(null)
  // Per-EPC active check-type tab. Defaults to 'preliminary'. Keyed by epc.id.
  const [activeCheckType, setActiveCheckType] = useState<Record<number, CheckType>>({})
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
    checkType: CheckType,
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
    setSubmittingResult({ epcId: epc.id, checkType, kind })
    setResultError(null)
    try {
      const body: Record<string, unknown> = {
        subsystemId,
        zoneName,
        checkTag: epc.checkTag,
        checkType,
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
            // Update only the fields for the check type that was committed.
            if (checkType === 'preliminary') {
              if ('reset' in action) {
                return { ...e, preliminaryResult: null, preliminaryComments: null, preliminaryFailureMode: null, preliminaryTestedBy: null, preliminaryTestedAt: null }
              }
              return {
                ...e,
                preliminaryResult: action.result,
                preliminaryTestedBy: currentUser?.fullName ?? null,
                preliminaryTestedAt: new Date().toISOString(),
                preliminaryFailureMode: action.result === 'fail' ? (action.failureMode ?? null) : null,
                preliminaryComments: action.result === 'fail' ? (action.comments ?? null) : e.preliminaryComments,
              }
            }
            if ('reset' in action) {
              return { ...e, finalResult: null, finalComments: null, finalFailureMode: null, finalTestedBy: null, finalTestedAt: null }
            }
            return {
              ...e,
              finalResult: action.result,
              finalTestedBy: currentUser?.fullName ?? null,
              finalTestedAt: new Date().toISOString(),
              finalFailureMode: action.result === 'fail' ? (action.failureMode ?? null) : null,
              finalComments: action.result === 'fail' ? (action.comments ?? null) : e.finalComments,
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

  // ── MCM-level rollup (answers "is the whole MCM nominal?") ──────────
  // One tool = one connection = one MCM, so every zone shares the same
  // MCM prefix. Derive it from the zones and roll their _Nominal_OK +
  // checked state up into a single banner the whole crew can read at a
  // glance, without expanding any zone.
  const mcmLabelFromZones = (() => {
    for (const z of allZones) {
      const mm = /^([A-Z]+\d+)_/.exec(z.name)
      if (mm) return mm[1]
    }
    return null
  })()
  const zonesNominal = allZones.filter(z => z.nominalOk === true).length
  const zonesFaulted = allZones.filter(z => z.nominalOk === false).length
  const zonesNominalKnown = allZones.filter(z => z.nominalOk === true || z.nominalOk === false).length
  const zonesChecked = allZones.filter(z => rollupZoneStatus(z.epcs) === 'all-checked').length
  // "Ready for checking" = nominal but not yet fully checked (req 4).
  const zonesReady = allZones.filter(z => z.nominalOk === true && rollupZoneStatus(z.epcs) !== 'all-checked').length
  type McmRollup = 'fault' | 'nominal' | 'partial' | 'unknown'
  const mcmRollup: McmRollup = !connected || zonesNominalKnown === 0
    ? 'unknown'
    : zonesFaulted > 0
      ? 'fault'
      : zonesNominal === allZones.length
        ? 'nominal'
        : 'partial'

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

      {/* MCM nominal banner — whole-MCM health at a glance (req 1). Single
          MCM per tool/connection, so this rolls up every zone's _Nominal_OK.
          Crew can read MCM state without expanding or selecting anything. */}
      {allZones.length > 0 && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border-2 px-4 py-3',
            mcmRollup === 'fault' ? 'border-red-500 bg-red-500/15'
              : mcmRollup === 'nominal' ? 'border-emerald-500 bg-emerald-500/15'
                : mcmRollup === 'partial' ? 'border-amber-500 bg-amber-500/15'
                  : 'border-border bg-muted',
          )}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            {mcmRollup === 'nominal'
              ? <ShieldCheck className="w-6 h-6 text-emerald-500 shrink-0" />
              : mcmRollup === 'unknown'
                ? <ShieldAlert className="w-6 h-6 text-muted-foreground shrink-0" />
                : <OctagonX className={cn('w-6 h-6 shrink-0', mcmRollup === 'fault' ? 'text-red-500' : 'text-amber-500')} />}
            <div className="min-w-0">
              {mcmLabelFromZones && (
                <div className="text-[11px] font-mono font-bold uppercase tracking-widest text-muted-foreground/80">
                  {mcmLabelFromZones}
                </div>
              )}
              <div className={cn(
                'text-base font-bold leading-tight',
                mcmRollup === 'fault' ? 'text-red-700 dark:text-red-300'
                  : mcmRollup === 'nominal' ? 'text-emerald-700 dark:text-emerald-300'
                    : mcmRollup === 'partial' ? 'text-amber-700 dark:text-amber-300'
                      : 'text-muted-foreground',
              )}>
                {mcmRollup === 'fault' ? `MCM FAULT — ${zonesFaulted} zone${zonesFaulted !== 1 ? 's' : ''} not nominal`
                  : mcmRollup === 'nominal' ? 'MCM NOMINAL — all zones healthy'
                    : mcmRollup === 'partial' ? `${zonesNominal}/${allZones.length} zones nominal`
                      : connected ? 'Awaiting PLC reads…' : 'PLC disconnected — no live state'}
              </div>
            </div>
          </div>
          {/* Compact rollup counts so reqs 4 & 5 also read at MCM level. */}
          <div className="flex items-center gap-3 ml-auto text-xs font-semibold tabular-nums">
            <span className="inline-flex items-center gap-1.5" title="Zones reading Nominal_OK = true">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
              {zonesNominal}/{allZones.length} nominal
            </span>
            <span className="inline-flex items-center gap-1.5" title="Zones with every EPC checked">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              {zonesChecked}/{allZones.length} checked
            </span>
            {zonesReady > 0 && (
              <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400" title="Nominal but not yet fully checked — ready for testing">
                <Play className="w-3.5 h-3.5" />
                {zonesReady} ready
              </span>
            )}
          </div>
        </div>
      )}

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

              // 2-axis annunciator matrix (per field directive):
              //
              //                    NOMINAL                NOT NOMINAL
              //   CHECKED      green border / green fill  green border / red fill
              //                "CHECKED AND NOMINAL"      "CHECKED, BUT NOT NOMINAL"
              //
              //   NOT CHECKED  red border / green fill    red border / red fill
              //                "READY FOR CHECKING"       "NOT READY FOR CHECKING"
              //
              // Border conveys CHECKED state (all EPC _CHECKED tags TRUE).
              // Fill conveys NOMINAL state (zone _Nominal_OK tag).
              // Glow only on "READY FOR CHECKING" (nominal but not yet checked).
              const allChecked = status === 'all-checked'
              const isNominal  = zone.nominalOk === true
              const isNotNominal = zone.nominalOk === false
              const isReady    = isNominal && !allChecked  // glow target + green pill

              // Border = checked state. Solid color for unambiguity.
              const borderColor = allChecked
                ? 'border-emerald-500 hover:border-emerald-400'
                : 'border-red-500 hover:border-red-400'

              // Fill = nominal state. Tinted (not flat-saturated) so EPC text
              // stays readable, but strong enough to read across the room.
              const fillBg = isNominal
                ? 'bg-emerald-500/20'
                : isNotNominal
                  ? 'bg-red-500/20'
                  : 'bg-muted'   // nominalOk null → no PLC read yet

              // Count chip — matches the border (checked-state) so the two
              // signals reinforce each other.
              const badgeBg = allChecked
                ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 ring-emerald-500/40'
                : 'bg-red-500/20 text-red-800 dark:text-red-300 ring-red-500/40'

              // Per-quadrant text label (Kevin's wording, matches the
              // matrix diagram exactly). Drops out entirely when Nominal_OK
              // is null — we don't know which quadrant we're in until the
              // PLC reads through.
              const stateLabel = (() => {
                if (zone.nominalOk == null) return null
                if (allChecked && isNominal)    return { text: 'Checked, nominal',                 tone: 'good' as const }
                if (allChecked && isNotNominal) return { text: 'Checked, not nominal',             tone: 'bad'  as const }
                if (!allChecked && isNominal)   return { text: 'Unchecked, ready for checking',    tone: 'good' as const }
                if (!allChecked && isNotNominal)return { text: 'Unchecked, not ready for checking',tone: 'bad'  as const }
                return null
              })()
              const stateLabelCls = stateLabel?.tone === 'good'
                ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-500/40'
                : 'bg-red-500/20 text-red-800 dark:text-red-300 border-red-500/40'

              // Split "MCM02_ZONE_01_04" → label "MCM02" + body "ZONE_01_04"
              const m = /^([A-Z]+\d+)_(.+)$/.exec(zone.name)
              const mcmLabel = m ? m[1] : ''
              const zoneLabel = m ? m[2] : zone.name

              const padCount = innerRows * 2 - zone.epcs.length

              return (
                <button
                  key={zone.id}
                  onClick={() => setSelectedZoneId(zone.id)}
                  title={
                    zone.nominalOkTag
                      ? `${zone.name} — ${zone.nominalOkTag} = ${
                          zone.nominalOk === true ? 'OK' :
                          zone.nominalOk === false ? 'FAULTED' : 'no data'
                        }`
                      : zone.name
                  }
                  className={cn(
                    'group relative flex flex-col overflow-hidden text-left rounded-lg border-2 transition-all',
                    'hover:shadow-lg hover:-translate-y-0.5',
                    fillBg,
                    borderColor,
                    isSelected && 'ring-2 ring-primary shadow-lg -translate-y-0.5',
                    // Glow when the zone is nominal AND there are EPCs still
                    // pending a pull-and-check. Draws the operator's eye to
                    // "this is what to work on next".
                    isReady && 'estop-zone-blink',
                  )}
                >

                  {/* Header */}
                  <div className="px-3 pt-3 pb-2 border-b border-border/60">
                    <div className="flex items-center justify-between gap-2">
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
                    {/* Per-quadrant state label — second line so longer
                        wording ("Unchecked, not ready for checking") fits
                        without truncating the zone title. */}
                    {stateLabel && (
                      <div className="mt-1.5">
                        <span
                          className={cn(
                            'inline-block text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border whitespace-nowrap',
                            stateLabelCls,
                          )}
                          title={
                            zone.nominalOkTag
                              ? `${zone.nominalOkTag} = ${isNominal ? 'TRUE (nominal)' : 'FALSE (not nominal)'}, ${checkedCount}/${zone.epcs.length} EPCs checked`
                              : undefined
                          }
                        >
                          {stateLabel.text}
                        </span>
                      </div>
                    )}
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
                        {/* Explicit "Checked" label next to the dot so the
                            green-dot/red-dot meaning is unambiguous: green +
                            "Checked" = cord has been pulled and verified.
                            No label = cord not yet pulled (the resting state). */}
                        {epc.checkTagValue === true && (
                          <span
                            className="text-[9px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 shrink-0"
                            title={`${epc.checkTag} = TRUE`}
                          >
                            Checked
                          </span>
                        )}
                        <MiniResultChip label="P" result={epc.preliminaryResult} />
                        <MiniResultChip label="F" result={epc.finalResult} />
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
            const ct: CheckType = activeCheckType[epc.id] ?? 'preliminary'
            // submitting state only lights the active type's buttons.
            const submitting = submittingResult?.epcId === epc.id && submittingResult.checkType === ct ? submittingResult.kind : null
            // Active-type recorded result + live auto-suggested verdict.
            const activeResult = ct === 'preliminary' ? epc.preliminaryResult : epc.finalResult
            const activeTestedBy = ct === 'preliminary' ? epc.preliminaryTestedBy : epc.finalTestedBy
            const activeTestedAt = ct === 'preliminary' ? epc.preliminaryTestedAt : epc.finalTestedAt
            const activeVerdict: AutoVerdict | undefined = ct === 'preliminary' ? epc.preliminaryVerdict : epc.finalVerdict
            // Pre-select the suggested verdict (the tester still must tap to commit).
            const suggestedPass = activeVerdict === 'pass'
            const suggestedFail = activeVerdict === 'fail'
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
                  <CheckedPill value={epc.checkTagValue} />
                </div>

                {/* Dual-check control bar: select Preliminary ("Zone Stop") or
                    Final ("Selectivity"), see that type's recorded result + the
                    live auto-suggested verdict, and commit Pass/Fail. */}
                <div className="px-4 py-3 border-b bg-muted/30 space-y-3">
                  {/* Check-type selector — each row shows its own recorded result. */}
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { key: 'preliminary' as const, title: 'Zone Stop', sub: 'Preliminary', result: epc.preliminaryResult, testedBy: epc.preliminaryTestedBy },
                      { key: 'final' as const, title: 'Selectivity', sub: 'Final', result: epc.finalResult, testedBy: epc.finalTestedBy },
                    ]).map(tab => {
                      const isActive = ct === tab.key
                      return (
                        <button
                          key={tab.key}
                          type="button"
                          onClick={() => setActiveCheckType(prev => ({ ...prev, [epc.id]: tab.key }))}
                          className={cn(
                            'flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition-colors',
                            isActive ? 'border-primary bg-primary/10 ring-1 ring-primary/40' : 'border-border bg-background hover:bg-muted/60',
                          )}
                        >
                          <div className="flex items-center gap-2 w-full">
                            <span className="text-xs font-semibold">{tab.title}</span>
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{tab.sub}</span>
                            <span className="ml-auto">
                              {tab.result === 'pass' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" aria-label="Passed" />}
                              {tab.result === 'fail' && <XCircle className="w-3.5 h-3.5 text-red-500" aria-label="Failed" />}
                            </span>
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            {tab.result
                              ? <>{tab.result === 'pass' ? 'Passed' : 'Failed'}{tab.testedBy ? ` · ${tab.testedBy}` : ''}</>
                              : 'Not recorded'}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  {/* Auto-suggested verdict + commit buttons for the active type. */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {activeVerdict && activeVerdict !== 'unknown' && (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-md border',
                          activeVerdict === 'pass' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/40'
                            : activeVerdict === 'fail' ? 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/40'
                              : 'bg-muted text-muted-foreground border-border',
                        )}
                        title="Live verdict computed from PLC tags — confirm to commit"
                      >
                        Suggested: {activeVerdict === 'pass' ? 'Pass' : activeVerdict === 'fail' ? 'Fail' : activeVerdict === 'ready' ? 'Ready (pull cord)' : '—'}
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant={activeResult === 'pass' ? 'default' : 'outline'}
                      className={cn(
                        'gap-1',
                        activeResult === 'pass' && 'bg-emerald-600 hover:bg-emerald-700 text-white',
                        activeResult !== 'pass' && suggestedPass && 'ring-2 ring-emerald-500/50',
                      )}
                      disabled={isServerDevice || submittingResult !== null}
                      onClick={() => submitEpcResult(epc, selectedZone.name, ct, { result: 'pass' })}
                    >
                      {submitting === 'pass' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                      Pass
                    </Button>
                    <Button
                      size="sm"
                      variant={activeResult === 'fail' ? 'default' : 'outline'}
                      className={cn(
                        'gap-1',
                        activeResult === 'fail' && 'bg-red-600 hover:bg-red-700 text-white',
                        activeResult !== 'fail' && suggestedFail && 'ring-2 ring-red-500/50',
                      )}
                      disabled={isServerDevice || submittingResult !== null}
                      onClick={() => {
                        setPendingFailEpc({ epc, zoneName: selectedZone.name, checkType: ct })
                        setFailDialogOpen(true)
                      }}
                    >
                      {submitting === 'fail' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                      Fail
                    </Button>
                    {activeResult && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1 text-muted-foreground"
                        disabled={isServerDevice || submittingResult !== null}
                        onClick={() => submitEpcResult(epc, selectedZone.name, ct, { reset: true })}
                        title="Clear this result"
                      >
                        {submitting === 'reset' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                      </Button>
                    )}
                  </div>
                </div>

                <CardContent className="p-4 space-y-5">
                  {activeTestedBy && (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold">{ct === 'preliminary' ? 'Preliminary' : 'Final'}</span>
                      {' '}marked <span className="font-semibold">{activeResult === 'pass' ? 'Pass' : 'Fail'}</span>
                      {' '}by <span className="font-medium">{activeTestedBy}</span>
                      {activeTestedAt && <> · {new Date(activeTestedAt).toLocaleString()}</>}
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
          submitEpcResult(pendingFailEpc.epc, pendingFailEpc.zoneName, pendingFailEpc.checkType, {
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
