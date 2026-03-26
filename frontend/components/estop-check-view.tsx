"use client"

import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, ShieldAlert, ChevronDown, ChevronRight } from 'lucide-react'
import { authFetch, API_ENDPOINTS } from '@/lib/api-config'
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

// ── Status helpers ─────────────────────────────────────────────────

function StatusDot({ active, size = 'sm' }: { active: boolean | null; size?: 'sm' | 'md' }) {
  const colors =
    active === true
      ? 'bg-emerald-400 shadow-emerald-400/50'
      : active === false
        ? 'bg-red-500 shadow-red-500/50'
        : 'bg-gray-500 shadow-gray-500/30'
  const sizeClass = size === 'md' ? 'w-3 h-3' : 'w-2.5 h-2.5'
  return <span className={cn('inline-block rounded-full shadow-sm', sizeClass, colors)} />
}

function VfdBadge({
  vfd,
  expectStoActive,
}: {
  vfd: Vfd
  expectStoActive: boolean
}) {
  // For "must stop" VFDs: stoActive === true means correctly stopped (green)
  // For "keep running" VFDs: stoActive === false means correctly running (green)
  const isGood = vfd.stoActive !== null && vfd.stoActive === expectStoActive
  const isBad = vfd.stoActive !== null && vfd.stoActive !== expectStoActive
  const isUnknown = vfd.stoActive === null

  const bgColor = isGood
    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
    : isBad
      ? 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30'
      : 'bg-muted text-muted-foreground border-border'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border',
        bgColor
      )}
      title={`${vfd.tag} | STO: ${vfd.stoTag} = ${vfd.stoActive === null ? 'N/A' : vfd.stoActive}`}
    >
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full',
          isGood ? 'bg-emerald-500' : isBad ? 'bg-red-500' : 'bg-gray-400'
        )}
      />
      {vfd.tag}
    </span>
  )
}

// ── Main Component ─────────────────────────────────────────────────

export default function EStopCheckView({ subsystemId }: EStopCheckViewProps) {
  const [data, setData] = useState<EStopStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedZones, setExpandedZones] = useState<Set<number>>(new Set())
  const abortRef = useRef<AbortController | null>(null)

  const toggleZone = (zoneId: number) => {
    setExpandedZones(prev => {
      const next = new Set(prev)
      if (next.has(zoneId)) {
        next.delete(zoneId)
      } else {
        next.add(zoneId)
      }
      return next
    })
  }

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null

    const fetchStatus = async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const url = subsystemId
          ? `/api/estop/status?subsystemId=${subsystemId}`
          : '/api/estop/status'
        const res = await authFetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: EStopStatusResponse = await res.json()
        setData(json)
        setError(null)

        // Auto-expand all zones on first load
        if (loading && json.zones.length > 0) {
          setExpandedZones(new Set(json.zones.map(z => z.id)))
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Failed to fetch EStop status')
      } finally {
        setLoading(false)
      }
    }

    fetchStatus()
    intervalId = setInterval(fetchStatus, 3000)

    return () => {
      if (intervalId) clearInterval(intervalId)
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsystemId])

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ── Error state ──
  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <ShieldAlert className="w-10 h-10 text-red-500" />
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    )
  }

  const zones = data?.zones ?? []
  const connected = data?.connected ?? false

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldAlert className="w-5 h-5 text-red-500" />
          <h2 className="text-lg font-semibold">Emergency Pull Cord Check</h2>
        </div>
        <Badge
          variant="outline"
          className={cn(
            'text-xs',
            connected
              ? 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400'
              : 'border-red-500/50 text-red-600 dark:text-red-400'
          )}
        >
          <span
            className={cn(
              'w-2 h-2 rounded-full mr-1.5',
              connected ? 'bg-emerald-500' : 'bg-red-500'
            )}
          />
          PLC {connected ? 'Connected' : 'Disconnected'}
        </Badge>
      </div>

      {/* Error banner (non-blocking, data may be stale) */}
      {error && data && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-1.5">
          Poll error: {error} — showing last known data
        </div>
      )}

      {/* Zones */}
      {zones.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
          <ShieldAlert className="w-8 h-8 mb-2 opacity-50" />
          <p className="text-sm">No EStop zones configured</p>
        </div>
      ) : (
        zones.map(zone => {
          const isExpanded = expandedZones.has(zone.id)
          return (
            <div key={zone.id} className="space-y-2">
              {/* Zone Header */}
              <button
                onClick={() => toggleZone(zone.id)}
                className="flex items-center gap-2 w-full text-left py-1.5 px-1 hover:bg-muted/50 rounded transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                )}
                <span className="font-semibold text-sm">{zone.name}</span>
                <Badge variant="secondary" className="text-xs ml-1">
                  {zone.epcs.length} EPC{zone.epcs.length !== 1 ? 's' : ''}
                </Badge>
              </button>

              {/* EPC Cards */}
              {isExpanded && (
                <div className="grid gap-3 ml-6">
                  {zone.epcs.map(epc => (
                    <EpcCard key={epc.id} epc={epc} zoneName={zone.name} />
                  ))}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

// ── EPC Card ───────────────────────────────────────────────────────

function EpcCard({ epc, zoneName }: { epc: Epc; zoneName: string }) {
  return (
    <Card className="border">
      <CardHeader className="py-2.5 px-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StatusDot active={epc.checkTagValue} size="md" />
            <CardTitle className="text-sm font-mono">{epc.name}</CardTitle>
          </div>
          <Badge variant="outline" className="text-xs">
            {zoneName}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0 space-y-3">
        {/* IO Points */}
        {epc.ioPoints.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">IO Points</p>
            <div className="flex flex-wrap gap-1.5">
              {epc.ioPoints.map(io => (
                <span
                  key={io.tag}
                  className={cn(
                    'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border',
                    io.value === true
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                      : io.value === false
                        ? 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30'
                        : 'bg-muted text-muted-foreground border-border'
                  )}
                >
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      io.value === true ? 'bg-emerald-500' : io.value === false ? 'bg-red-500' : 'bg-gray-400'
                    )}
                  />
                  {io.tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Must Stop VFDs */}
        {epc.mustStopVfds.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">
              Must Stop
              <span className="ml-1 opacity-60">({epc.mustStopVfds.length})</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {epc.mustStopVfds.map(vfd => (
                <VfdBadge key={vfd.tag} vfd={vfd} expectStoActive={true} />
              ))}
            </div>
          </div>
        )}

        {/* Keep Running VFDs */}
        {epc.keepRunningVfds.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1.5">
              Keep Running
              <span className="ml-1 opacity-60">({epc.keepRunningVfds.length})</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {epc.keepRunningVfds.map(vfd => (
                <VfdBadge key={vfd.tag} vfd={vfd} expectStoActive={false} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
