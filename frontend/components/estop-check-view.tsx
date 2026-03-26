"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, ShieldAlert, Search, X, ChevronDown, ChevronRight, OctagonX, Play, Square } from 'lucide-react'
import { authFetch } from '@/lib/api-config'
import { cn } from '@/lib/utils'

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

interface Epc {
  id: number
  name: string
  checkTag: string
  checkTagValue: boolean | null
  ioPoints: IoPoint[]
  mustStopVfds: Vfd[]
  keepRunningVfds: Vfd[]
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
    active === true ? 'bg-emerald-400 shadow-emerald-400/50'
      : active === false ? 'bg-red-500 shadow-red-500/50'
        : 'bg-gray-500 shadow-gray-500/30'
  const sz = size === 'lg' ? 'w-3.5 h-3.5' : size === 'md' ? 'w-3 h-3' : 'w-2.5 h-2.5'
  return <span className={cn('inline-block rounded-full shadow-sm', sz, color)} />
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

function EpcSummary({ epc }: { epc: Epc }) {
  const mustStopOk = epc.mustStopVfds.filter(v => v.stoActive === true).length
  const mustStopBad = epc.mustStopVfds.filter(v => v.stoActive === false).length
  const keepRunOk = epc.keepRunningVfds.filter(v => v.stoActive === false).length
  const keepRunBad = epc.keepRunningVfds.filter(v => v.stoActive === true).length
  const totalVfds = epc.mustStopVfds.length + epc.keepRunningVfds.length
  const totalOk = mustStopOk + keepRunOk
  const totalBad = mustStopBad + keepRunBad
  const noData = totalOk === 0 && totalBad === 0

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {noData ? (
        <span>No PLC data</span>
      ) : (
        <>
          {totalOk > 0 && <span className="text-emerald-600 dark:text-emerald-400">{totalOk}/{totalVfds} OK</span>}
          {totalBad > 0 && <span className="text-red-600 dark:text-red-400">{totalBad} FAIL</span>}
        </>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────

export default function EStopCheckView({ subsystemId }: EStopCheckViewProps) {
  const [data, setData] = useState<EStopStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedEpc, setSelectedEpc] = useState<number | null>(null)
  const [expandedZones, setExpandedZones] = useState<Set<number>>(new Set())
  const abortRef = useRef<AbortController | null>(null)
  const lastDataRef = useRef<string>('')

  const toggleZone = useCallback((zoneId: number) => {
    setExpandedZones(prev => {
      const next = new Set(prev)
      next.has(zoneId) ? next.delete(zoneId) : next.add(zoneId)
      return next
    })
  }, [])

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
        if (loading && json.zones.length > 0) {
          setExpandedZones(new Set(json.zones.map(z => z.id)))
          // Auto-select first EPC so detail panel is always visible
          const firstEpc = json.zones[0]?.epcs[0]
          if (firstEpc && !selectedEpc) setSelectedEpc(firstEpc.id)
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Failed to fetch')
      } finally {
        setLoading(false)
      }
    }

    fetchStatus()
    const id = setInterval(fetchStatus, 3000)
    return () => { clearInterval(id); abortRef.current?.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsystemId])

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
  }
  if (error && !data) {
    return <div className="flex flex-col items-center justify-center h-64 gap-3"><ShieldAlert className="w-10 h-10 text-red-500" /><p className="text-sm text-muted-foreground">{error}</p></div>
  }

  const allZones = data?.zones ?? []
  const connected = data?.connected ?? false
  const search = searchTerm.toLowerCase().trim()

  // Filter
  const zones = search
    ? allZones.map(zone => {
        const epcs = zone.epcs.filter(epc =>
          epc.name.toLowerCase().includes(search) ||
          epc.checkTag.toLowerCase().includes(search) ||
          zone.name.toLowerCase().includes(search) ||
          epc.ioPoints.some(io => io.tag.toLowerCase().includes(search)) ||
          epc.mustStopVfds.some(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search)) ||
          epc.keepRunningVfds.some(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search))
        )
        return epcs.length > 0 ? { ...zone, epcs } : null
      }).filter((z): z is Zone => z !== null)
    : allZones

  // Find selected EPC data (from unfiltered data for full detail)
  const selectedEpcData = selectedEpc
    ? allZones.flatMap(z => z.epcs).find(e => e.id === selectedEpc) ?? null
    : null
  const selectedZoneName = selectedEpc
    ? allZones.find(z => z.epcs.some(e => e.id === selectedEpc))?.name ?? ''
    : ''

  // Filter VFDs within detail if searching
  const detailMustStop = selectedEpcData && search
    ? selectedEpcData.mustStopVfds.filter(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search))
    : selectedEpcData?.mustStopVfds ?? []
  const detailKeepRun = selectedEpcData && search
    ? selectedEpcData.keepRunningVfds.filter(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search))
    : selectedEpcData?.keepRunningVfds ?? []
  // If search doesn't match any VFDs specifically, show all
  const showAllVfds = search && detailMustStop.length === 0 && detailKeepRun.length === 0
  const finalMustStop = showAllVfds ? (selectedEpcData?.mustStopVfds ?? []) : detailMustStop
  const finalKeepRun = showAllVfds ? (selectedEpcData?.keepRunningVfds ?? []) : detailKeepRun

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
          placeholder="Search EPCs, VFDs, zones, tags..."
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

      <div className="flex gap-4">
        {/* Left: Zone list with compact EPC cards */}
        <div className="w-2/5 min-w-[300px] max-w-[480px] space-y-3 overflow-y-auto">
          {zones.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <ShieldAlert className="w-8 h-8 mb-2 opacity-50" />
              <p className="text-sm">{search ? 'No matches' : 'No EStop zones configured'}</p>
            </div>
          ) : (
            zones.map(zone => {
              const isExpanded = expandedZones.has(zone.id)
              return (
                <div key={zone.id}>
                  <button
                    onClick={() => toggleZone(zone.id)}
                    className="flex items-center gap-2 w-full text-left py-1.5 px-1 hover:bg-muted/50 rounded transition-colors"
                  >
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                    <span className="font-semibold text-sm">{zone.name}</span>
                    <Badge variant="secondary" className="text-xs ml-1">{zone.epcs.length}</Badge>
                  </button>

                  {isExpanded && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 ml-5 mt-1">
                      {zone.epcs.map(epc => (
                        <button
                          key={epc.id}
                          onClick={() => setSelectedEpc(epc.id)}
                          className={cn(
                            'flex flex-col items-center justify-center p-2 rounded-lg border text-center transition-all hover:shadow-md aspect-square',
                            selectedEpc === epc.id
                              ? 'border-primary bg-primary/5 shadow-md ring-1 ring-primary/30'
                              : 'border-border hover:border-muted-foreground/30'
                          )}
                        >
                          <StatusDot active={epc.checkTagValue} size="lg" />
                          <p className="text-[10px] font-mono font-medium mt-1 leading-tight">{epc.name}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Right: Detail panel for selected EPC */}
        {selectedEpcData && (
          <div className="flex-1 min-w-0 overflow-y-auto">
            <Card className="sticky top-0">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <div className="flex items-center gap-3">
                  <StatusDot active={selectedEpcData.checkTagValue} size="lg" />
                  <div>
                    <h3 className="font-mono font-semibold text-base">{selectedEpcData.name}</h3>
                    <p className="text-xs text-muted-foreground font-mono">{selectedEpcData.checkTag}</p>
                  </div>
                </div>
                <Badge variant="outline" className="text-xs">{selectedZoneName}</Badge>
              </div>

              <CardContent className="p-4 space-y-5">
                {/* IO Points */}
                {selectedEpcData.ioPoints.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">IO Points (Normally Closed)</p>
                    <div className="flex flex-wrap gap-2">
                      {selectedEpcData.ioPoints.map(io => (
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

                {/* Must Stop VFDs */}
                {finalMustStop.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Square className="w-3.5 h-3.5 text-red-500" />
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Must Stop <span className="normal-case opacity-60">({finalMustStop.length})</span>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {finalMustStop.map(vfd => (
                        <VfdBadge key={vfd.tag} vfd={vfd} expectStoActive={true} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Keep Running VFDs */}
                {finalKeepRun.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Play className="w-3.5 h-3.5 text-emerald-500" />
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Keep Running <span className="normal-case opacity-60">({finalKeepRun.length})</span>
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
          </div>
        )}
      </div>
    </div>
  )
}
