"use client"

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  Zap, Search, X, Wifi, WifiOff, ArrowRight,
} from 'lucide-react'
import { VfdWizardModal } from './vfd-wizard-modal'

// ── Types ──────────────────────────────────────────────────────────

interface VfdDevice { id: number; deviceName: string; mcm: string; subsystem: string }

interface VfdCommissioningViewProps {
  devices: VfdDevice[]
  subsystemId: number
  plcConnected: boolean
}

type CheckStatus = 'pass' | 'fail' | null

interface DeviceState {
  checks: [CheckStatus, CheckStatus, CheckStatus, CheckStatus, CheckStatus]
  speedFpm: number | null
  lastRpm: number | null
}

// Field groups moved to VfdWizardModal

// ── Helpers ────────────────────────────────────────────────────────

async function writeTag(deviceName: string, field: string, value: number, dataType: 'BOOL' | 'REAL' | 'INT') {
  const res = await fetch('/api/vfd-commissioning/write-tag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName, field, value, dataType }),
  })
  return res.json()
}

async function saveCheckState(deviceName: string, subsystemId: number, check: number, status: CheckStatus, extra?: Record<string, any>) {
  await fetch('/api/vfd-commissioning/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName, subsystemId, check, status, ...extra }),
  })
}

// ── Sub-components ─────────────────────────────────────────────────

function StatusDots({ checks }: { checks: CheckStatus[] }) {
  return (
    <div className="flex items-center gap-1">
      {checks.map((s, i) => (
        <div key={i} className={cn(
          "h-3 w-3 rounded-full border",
          s === 'pass' && "bg-green-500 border-green-600 dark:bg-green-400 dark:border-green-500",
          s === 'fail' && "bg-red-500 border-red-600 dark:bg-red-400 dark:border-red-500",
          !s && "bg-muted border-border"
        )} />
      ))}
    </div>
  )
}

// PassFailInline and VfdExpandedPanel removed — replaced by VfdWizardModal

// ── Virtual scroll constants ───────────────────────────────────────

const ROW_HEIGHT = 48
const EXPANDED_HEIGHT = 340
const OVERSCAN = 5

// ── Main Component ─────────────────────────────────────────────────

export function VfdCommissioningView({ devices, subsystemId, plcConnected }: VfdCommissioningViewProps) {
  const [states, setStates] = useState<Map<string, DeviceState>>(new Map())
  const [searchTerm, setSearchTerm] = useState('')
  const [mcmFilter, setMcmFilter] = useState<string>('all')
  const [wizardDevice, setWizardDevice] = useState<VfdDevice | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(800)

  // Load saved check states from DB (no PLC reads)
  useEffect(() => {
    fetch(`/api/vfd-commissioning/state?subsystemId=${subsystemId}`)
      .then(r => r.json())
      .then(data => {
        const map = new Map<string, DeviceState>()
        for (const row of (data.states || [])) {
          map.set(row.deviceName, {
            checks: [row.check1_status, row.check2_status, row.check3_status, row.check4_status, row.check5_status],
            speedFpm: row.speed_fpm,
            lastRpm: row.last_rpm,
          })
        }
        setStates(map)
      })
      .catch(() => {})
  }, [subsystemId])

  const getState = (name: string): DeviceState =>
    states.get(name) || { checks: [null, null, null, null, null], speedFpm: null, lastRpm: null }

  const handleCheckChange = useCallback((deviceName: string, checkIdx: number, status: CheckStatus) => {
    setStates(prev => {
      const next = new Map(prev)
      const current = next.get(deviceName) || { checks: [null, null, null, null, null], speedFpm: null, lastRpm: null }
      const checks = [...current.checks] as DeviceState['checks']
      checks[checkIdx] = status
      next.set(deviceName, { ...current, checks })
      return next
    })
    saveCheckState(deviceName, subsystemId, checkIdx + 1, status)
  }, [subsystemId])

  // Filters
  const mcmValues = useMemo(() => Array.from(new Set(devices.map(d => d.mcm).filter(Boolean))).sort(), [devices])

  const filtered = useMemo(() => {
    return devices.filter(d => {
      if (searchTerm) {
        const q = searchTerm.toLowerCase()
        if (!d.deviceName.toLowerCase().includes(q) && !d.mcm.toLowerCase().includes(q)) return false
      }
      if (mcmFilter !== 'all' && d.mcm !== mcmFilter) return false
      return true
    })
  }, [devices, searchTerm, mcmFilter])

  // Stats
  const passedCount = devices.filter(d => getState(d.deviceName).checks.every(c => c === 'pass')).length

  // Virtual scroll
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => { for (const e of entries) setContainerHeight(e.contentRect.height) })
    obs.observe(el)
    setContainerHeight(el.clientHeight)
    return () => obs.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop)
  }, [])

  const { visibleRows, totalHeight, offsetY } = useMemo(() => {
    const heights = filtered.map(() => ROW_HEIGHT)
    const total = heights.reduce((s, h) => s + h, 0)

    let startIdx = 0
    let acc = 0
    while (startIdx < filtered.length && acc + heights[startIdx] < scrollTop) { acc += heights[startIdx]; startIdx++ }
    startIdx = Math.max(0, startIdx - OVERSCAN)

    let offset = 0
    for (let i = 0; i < startIdx; i++) offset += heights[i]

    let endIdx = startIdx
    let visH = 0
    while (endIdx < filtered.length && visH < containerHeight + OVERSCAN * ROW_HEIGHT * 2) { visH += heights[endIdx]; endIdx++ }
    endIdx = Math.min(filtered.length, endIdx + OVERSCAN)

    return {
      visibleRows: filtered.slice(startIdx, endIdx),
      totalHeight: total,
      offsetY: offset,
    }
  }, [filtered, scrollTop, containerHeight])

  if (devices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
        <Zap className="h-12 w-12 mb-4 opacity-30" />
        <p className="text-base font-medium">No VFD devices</p>
        <p className="text-sm mt-1">Import VFD device data to enable commissioning</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-card shrink-0">
        <Zap className="h-5 w-5 text-amber-500" />
        <span className="text-base font-semibold">VFD Commissioning</span>
        <Badge className="bg-muted text-foreground border font-mono text-xs px-2 py-0.5">{devices.length} devices</Badge>
        <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-800 font-mono text-xs px-2 py-0.5">{passedCount} complete</Badge>
        <div className="flex-1" />
        <div className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border",
          plcConnected
            ? "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-800"
            : "bg-muted text-muted-foreground border-border"
        )}>
          {plcConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          {plcConnected ? "PLC" : "Offline"}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-muted/30 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search device or MCM..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="h-8 w-52 pl-8 text-sm bg-background"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {mcmValues.length > 1 && (
          <select value={mcmFilter} onChange={e => setMcmFilter(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
            <option value="all">All MCMs</option>
            {mcmValues.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        {(searchTerm || mcmFilter !== 'all') && (
          <button onClick={() => { setSearchTerm(''); setMcmFilter('all') }} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            <X className="h-3 w-3" />Clear
          </button>
        )}
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">{filtered.length} of {devices.length}</span>
      </div>

      {/* Virtualized list */}
      <div ref={scrollRef} className="flex-1 overflow-auto" onScroll={handleScroll}>
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {visibleRows.map(device => {
              const state = getState(device.deviceName)
              const allPassed = state.checks.every(c => c === 'pass')
              const hasFail = state.checks.some(c => c === 'fail')

              return (
                <div
                  key={device.id}
                  className={cn(
                    "border-b flex items-center gap-3 px-4 cursor-pointer hover:bg-muted/40 transition-colors group",
                    allPassed && "bg-green-50/50 dark:bg-green-950/15",
                    hasFail && "bg-red-50/50 dark:bg-red-950/15"
                  )}
                  style={{ height: ROW_HEIGHT }}
                  onClick={() => setWizardDevice(device)}
                >
                  <Zap className="h-4 w-4 text-amber-500 shrink-0" />
                  <span className="font-mono font-semibold text-sm w-[180px] truncate">{device.deviceName}</span>
                  <span className="text-xs text-muted-foreground w-[160px] truncate">{device.mcm}</span>
                  <StatusDots checks={state.checks} />
                  <div className="flex-1" />
                  <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Wizard Modal */}
      {wizardDevice && (
        <VfdWizardModal
          device={wizardDevice}
          plcConnected={plcConnected}
          onClose={() => setWizardDevice(null)}
        />
      )}
    </div>
  )
}
