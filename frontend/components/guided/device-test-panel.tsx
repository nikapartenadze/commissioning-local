import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { X, SkipForward, Check, AlertCircle, CircleDashed } from 'lucide-react'
import type { Device, IoSummary } from '@/lib/guided/types'

interface Props {
  device: Device
  subsystemId: number
  onClose: () => void
  onSkip: (deviceName: string) => void
}

interface IoLocalState {
  /** Optimistic in-memory result that overrides the DB-loaded result for visual feedback only. */
  uiResult: 'Passed' | 'Failed' | null
}

/**
 * Right-side drawer that lists a device's IOs and lets the operator click
 * Pass / Fail / Skip. PHASE 1: all interactions are visual only — no DB
 * writes, no /api/test calls, no PLC writes. Toasts confirm the click.
 */
export function DeviceTestPanel({ device, subsystemId, onClose, onSkip }: Props) {
  const [ios, setIos] = useState<IoSummary[] | null>(null)
  const [localState, setLocalState] = useState<Record<number, IoLocalState>>({})

  useEffect(() => {
    let cancelled = false
    fetch(`/api/guided/devices/${encodeURIComponent(device.deviceName)}?subsystemId=${subsystemId}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setIos(data.ios ?? [])
      })
      .catch(err => {
        console.error('[DeviceTestPanel] Failed to load device IOs:', err)
        if (!cancelled) setIos([])
      })
    return () => { cancelled = true }
  }, [device.deviceName, subsystemId])

  function effectiveResult(io: IoSummary): 'Passed' | 'Failed' | null {
    return localState[io.id]?.uiResult ?? io.result
  }

  function markPass(ioId: number) {
    setLocalState(s => ({ ...s, [ioId]: { uiResult: 'Passed' } }))
  }
  function markFail(ioId: number) {
    setLocalState(s => ({ ...s, [ioId]: { uiResult: 'Failed' } }))
  }

  // Find the first untested IO (effective) — the "current IO" within the device.
  const currentIo = ios?.find(io => effectiveResult(io) === null) ?? null

  return (
    <aside className="fixed right-0 top-0 h-full w-[420px] bg-white border-l shadow-2xl z-30 flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold truncate">{device.deviceName}</h2>
          <p className="text-xs text-muted-foreground">
            {device.passedIos + device.failedIos} of {device.totalIos} tested
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onSkip(device.deviceName)}>
          <SkipForward className="w-4 h-4 mr-1" /> Skip
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {ios === null && <div className="text-sm text-muted-foreground">Loading IOs…</div>}
        {ios !== null && ios.length === 0 && (
          <div className="text-sm text-muted-foreground">No IOs configured for this device.</div>
        )}

        {currentIo && (
          <div className="border-2 border-blue-500 rounded-lg p-4 bg-blue-50">
            <div className="text-xs text-blue-700 font-semibold mb-1">CURRENT IO</div>
            <div className="font-mono text-sm font-bold">{currentIo.name}</div>
            {currentIo.description && (
              <div className="text-xs text-muted-foreground mt-1">{currentIo.description}</div>
            )}
            <div className="flex gap-2 mt-3">
              <Button size="sm" onClick={() => markPass(currentIo.id)}>
                <Check className="w-4 h-4 mr-1" /> Pass
              </Button>
              <Button size="sm" variant="destructive" onClick={() => markFail(currentIo.id)}>
                <AlertCircle className="w-4 h-4 mr-1" /> Fail
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 italic">
              Phase 1: marks visually only. No DB or PLC writes.
            </p>
          </div>
        )}

        {ios && ios.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs uppercase text-muted-foreground font-semibold">All IOs</div>
            {ios.map(io => {
              const r = effectiveResult(io)
              const Icon = r === 'Passed' ? Check : r === 'Failed' ? AlertCircle : CircleDashed
              const colorClass = r === 'Passed' ? 'text-green-600'
                : r === 'Failed' ? 'text-red-600' : 'text-muted-foreground'
              return (
                <div key={io.id} className="flex items-center gap-2 text-sm py-1">
                  <Icon className={`w-4 h-4 shrink-0 ${colorClass}`} />
                  <span className="font-mono text-xs truncate flex-1">{io.name}</span>
                  {r === null && currentIo?.id !== io.id && (
                    <Button size="sm" variant="outline" onClick={() => markPass(io.id)}>
                      Pass
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
