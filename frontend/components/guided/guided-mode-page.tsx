import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGuidedSession } from '@/lib/guided/use-guided-session'
import { findCurrentTarget } from '@/lib/guided/device-state'
import { GuidedTestingMap } from './guided-testing-map'
import { DeviceTestPanel } from './device-test-panel'

export function GuidedModePage() {
  const { id } = useParams<{ id: string }>()
  const subsystemId = id ? parseInt(id, 10) : NaN
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const { state, openDevice, closeDevice, skipDevice } = useGuidedSession(subsystemId)

  useEffect(() => {
    if (!subsystemId || isNaN(subsystemId)) return
    let cancelled = false
    fetch(`/api/maps/subsystem/${subsystemId}`)
      .then(r => r.text())
      .then(text => { if (!cancelled) setSvgMarkup(text) })
      .catch(err => {
        console.error('[GuidedModePage] Failed to load SVG:', err)
        if (!cancelled) setSvgMarkup('')
      })
    return () => { cancelled = true }
  }, [subsystemId])

  const currentTarget = findCurrentTarget(state.devices)
  const selectedDevice = state.selectedDevice
    ? state.devices.find(d => d.deviceName === state.selectedDevice) ?? null
    : null

  const totals = state.devices.reduce((acc, d) => {
    acc[d.state] = (acc[d.state] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)
  const completed = (totals.passed ?? 0) + (totals.failed ?? 0)
  const total = state.devices.length

  if (!subsystemId || isNaN(subsystemId)) {
    return <div className="p-8">Invalid subsystem id</div>
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-background">
      {/* Header */}
      <header className="h-12 border-b flex items-center px-3 gap-3 shrink-0">
        <Button asChild variant="ghost" size="sm">
          <Link to={`/commissioning/${subsystemId}`}>
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Link>
        </Button>
        <div className="text-sm font-semibold">Guided · Subsystem {subsystemId}</div>
        <div className="flex-1 flex justify-center">
          <div className="text-xs text-muted-foreground">
            {completed} / {total} done
            {totals.in_progress ? ` · ${totals.in_progress} in progress` : ''}
            {totals.skipped ? ` · ${totals.skipped} skipped` : ''}
            {totals.failed ? ` · ${totals.failed} failed` : ''}
          </div>
        </div>
        <div className="text-[10px] uppercase text-amber-600 font-semibold">Prototype · no writes</div>
      </header>

      {/* Body */}
      <main className="flex-1 relative overflow-hidden">
        {state.isLoading || svgMarkup === null ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">Loading map…</div>
        ) : svgMarkup === '' ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            No map available for this subsystem.
          </div>
        ) : (
          <GuidedTestingMap
            svgMarkup={svgMarkup}
            devices={state.devices}
            currentTarget={currentTarget}
            onDeviceClick={openDevice}
          />
        )}

        {/* Floating Next chip */}
        {currentTarget && !selectedDevice && (
          <button
            type="button"
            onClick={() => openDevice(currentTarget.deviceName)}
            className="absolute bottom-4 right-4 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 text-sm font-semibold"
          >
            <MapPin className="w-4 h-4" />
            Next: {currentTarget.deviceName}
            <span aria-hidden>→</span>
          </button>
        )}

        {/* Drawer */}
        {selectedDevice && (
          <DeviceTestPanel
            device={selectedDevice}
            subsystemId={subsystemId}
            onClose={closeDevice}
            onSkip={skipDevice}
          />
        )}
      </main>
    </div>
  )
}
