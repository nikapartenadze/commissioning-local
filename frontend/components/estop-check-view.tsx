"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, ShieldAlert, Search, X, ChevronDown, ChevronRight, OctagonX, Play, Square } from 'lucide-react'
import { authFetch } from '@/lib/api-config'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────

interface IoPoint { tag: string; value: boolean | null }
interface Vfd { tag: string; stoTag: string; stoActive: boolean | null }
interface Epc {
  id: number; name: string; checkTag: string; checkTagValue: boolean | null
  ioPoints: IoPoint[]; mustStopVfds: Vfd[]; keepRunningVfds: Vfd[]
}
interface Zone { id: number; name: string; epcs: Epc[] }
interface EStopStatusResponse { success: boolean; connected: boolean; zones: Zone[] }
interface EStopCheckViewProps { subsystemId?: number }

// ── Helpers ─────────────────────────────────────────────────────────

function VfdBadge({ vfd, expectStoActive }: { vfd: Vfd; expectStoActive: boolean }) {
  const isGood = vfd.stoActive !== null && vfd.stoActive === expectStoActive
  const isBad = vfd.stoActive !== null && vfd.stoActive !== expectStoActive
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-mono rounded border transition-colors',
        isGood ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
          : isBad ? 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30'
            : 'bg-muted text-muted-foreground border-border'
      )}
      title={`${vfd.stoTag} = ${vfd.stoActive === null ? 'N/A' : vfd.stoActive}`}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', isGood ? 'bg-emerald-500' : isBad ? 'bg-red-500' : 'bg-gray-400')} />
      {vfd.tag}
    </span>
  )
}

/** Compact horizontal EPC card with left status bar */
function EpcCard({ epc, isSelected, onClick }: { epc: Epc; isSelected: boolean; onClick: () => void }) {
  const statusColor = epc.checkTagValue === true ? 'bg-emerald-500' : epc.checkTagValue === false ? 'bg-red-500' : 'bg-gray-400'
  const totalVfds = epc.mustStopVfds.length + epc.keepRunningVfds.length
  const okCount = epc.mustStopVfds.filter(v => v.stoActive === true).length + epc.keepRunningVfds.filter(v => v.stoActive === false).length
  const failCount = epc.mustStopVfds.filter(v => v.stoActive === false).length + epc.keepRunningVfds.filter(v => v.stoActive === true).length
  const noData = okCount === 0 && failCount === 0

  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-2.5 pl-0 pr-3 py-1.5 rounded-md border text-left transition-all group overflow-hidden',
        isSelected
          ? 'border-primary/60 bg-primary/5 shadow-sm ring-1 ring-primary/20'
          : 'border-border/60 hover:border-border hover:bg-muted/30'
      )}
    >
      {/* Left status bar */}
      <div className={cn('w-1 self-stretch rounded-l-md shrink-0', statusColor)} />

      {/* Content */}
      <div className="flex-1 min-w-0 py-0.5">
        <p className="text-xs font-mono font-semibold leading-none truncate">{epc.name}</p>
        <p className="text-[10px] text-muted-foreground mt-1 leading-none">
          {noData ? (
            <span className="opacity-50">No PLC</span>
          ) : (
            <>
              {okCount > 0 && <span className="text-emerald-600 dark:text-emerald-400">{okCount}</span>}
              {okCount > 0 && failCount > 0 && <span className="mx-0.5 opacity-40">/</span>}
              {failCount > 0 && <span className="text-red-500">{failCount}</span>}
              <span className="opacity-40 ml-0.5">of {totalVfds}</span>
            </>
          )}
        </p>
      </div>
    </button>
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

  const selectedEpcData = selectedEpc ? allZones.flatMap(z => z.epcs).find(e => e.id === selectedEpc) ?? null : null
  const selectedZoneName = selectedEpc ? allZones.find(z => z.epcs.some(e => e.id === selectedEpc))?.name ?? '' : ''

  const detailMustStop = selectedEpcData && search
    ? selectedEpcData.mustStopVfds.filter(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search))
    : selectedEpcData?.mustStopVfds ?? []
  const detailKeepRun = selectedEpcData && search
    ? selectedEpcData.keepRunningVfds.filter(v => v.tag.toLowerCase().includes(search) || v.stoTag.toLowerCase().includes(search))
    : selectedEpcData?.keepRunningVfds ?? []
  const showAllVfds = search && detailMustStop.length === 0 && detailKeepRun.length === 0
  const finalMustStop = showAllVfds ? (selectedEpcData?.mustStopVfds ?? []) : detailMustStop
  const finalKeepRun = showAllVfds ? (selectedEpcData?.keepRunningVfds ?? []) : detailKeepRun

  return (
    <div className="p-4 space-y-3 h-full flex flex-col">
      {/* Header row */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <OctagonX className="w-5 h-5 text-red-500" />
          <h2 className="text-base font-semibold">EStop Check</h2>
        </div>
        <div className="flex items-center gap-2">
          {/* Search inline */}
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-7 py-1.5 text-xs border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            {searchTerm && (
              <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <Badge variant="outline" className={cn('text-[10px] shrink-0', connected ? 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400' : 'border-red-500/50 text-red-600 dark:text-red-400')}>
            <span className={cn('w-1.5 h-1.5 rounded-full mr-1', connected ? 'bg-emerald-500' : 'bg-red-500')} />
            PLC
          </Badge>
        </div>
      </div>

      {error && data && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-1 shrink-0">
          {error}
        </div>
      )}

      {/* Main split layout */}
      <div className="flex gap-3 flex-1 min-h-0 overflow-hidden">
        {/* Left: EPC selector */}
        <div className="w-[340px] shrink-0 overflow-y-auto space-y-2 pr-1">
          {zones.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
              <ShieldAlert className="w-6 h-6 mb-1.5 opacity-40" />
              <p className="text-xs">{search ? 'No matches' : 'No data'}</p>
            </div>
          ) : (
            zones.map(zone => {
              const isExpanded = expandedZones.has(zone.id)
              return (
                <div key={zone.id}>
                  <button
                    onClick={() => toggleZone(zone.id)}
                    className="flex items-center gap-1.5 w-full text-left py-1 px-0.5 hover:bg-muted/40 rounded transition-colors"
                  >
                    {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                    <span className="text-xs font-semibold truncate">{zone.name}</span>
                    <Badge variant="secondary" className="text-[10px] ml-auto shrink-0 px-1.5 py-0">{zone.epcs.length}</Badge>
                  </button>

                  {isExpanded && (
                    <div className="flex flex-wrap gap-1.5 ml-4 mt-1 mb-2">
                      {zone.epcs.map(epc => (
                        <EpcCard
                          key={epc.id}
                          epc={epc}
                          isSelected={selectedEpc === epc.id}
                          onClick={() => setSelectedEpc(epc.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Right: Detail panel */}
        {selectedEpcData && (
          <div className="flex-1 min-w-0 overflow-y-auto">
            <Card className="h-full">
              {/* Detail header */}
              <div className="flex items-center gap-3 px-4 py-3 border-b">
                <div className={cn(
                  'w-2.5 h-2.5 rounded-full shrink-0 shadow-sm',
                  selectedEpcData.checkTagValue === true ? 'bg-emerald-400 shadow-emerald-400/40'
                    : selectedEpcData.checkTagValue === false ? 'bg-red-500 shadow-red-500/40'
                      : 'bg-gray-500'
                )} />
                <div className="flex-1 min-w-0">
                  <h3 className="font-mono font-semibold text-sm leading-none">{selectedEpcData.name}</h3>
                  <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{selectedEpcData.checkTag}</p>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">{selectedZoneName}</Badge>
              </div>

              <CardContent className="p-4 space-y-4">
                {/* IO Points */}
                {selectedEpcData.ioPoints.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">IO Points (NC)</p>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedEpcData.ioPoints.map(io => (
                        <span
                          key={io.tag}
                          className={cn(
                            'inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono rounded border',
                            io.value === true ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                              : io.value === false ? 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30'
                                : 'bg-muted text-muted-foreground border-border'
                          )}
                        >
                          <span className={cn('w-1.5 h-1.5 rounded-full', io.value === true ? 'bg-emerald-500' : io.value === false ? 'bg-red-500' : 'bg-gray-400')} />
                          {io.tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Must Stop */}
                {finalMustStop.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Square className="w-3 h-3 text-red-500" />
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        Must Stop <span className="normal-case opacity-50">({finalMustStop.length})</span>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {finalMustStop.map(vfd => <VfdBadge key={vfd.tag} vfd={vfd} expectStoActive={true} />)}
                    </div>
                  </div>
                )}

                {/* Keep Running */}
                {finalKeepRun.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Play className="w-3 h-3 text-emerald-500" />
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        Keep Running <span className="normal-case opacity-50">({finalKeepRun.length})</span>
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {finalKeepRun.map(vfd => <VfdBadge key={vfd.tag} vfd={vfd} expectStoActive={false} />)}
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
