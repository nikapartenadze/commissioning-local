import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Crosshair, GitBranch, ChevronDown, PanelRightClose, PanelRightOpen, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useGuidedSession } from '@/lib/guided/use-guided-session'
import { findCurrentTarget } from '@/lib/guided/device-state'
import { GuidedTestingMap, type GuidedTestingMapHandle } from './guided-testing-map'
import { DeviceTestPanel } from './device-test-panel'
import { RoadmapPathOverlay } from './roadmap-path-overlay'
import { RoadmapPicker } from './roadmap-picker'
import { useRoadmapSession } from '@/lib/guided/use-roadmap-session'
import { shouldAdvanceStep } from '@/lib/guided/roadmap-advance'
import type { Roadmap } from '@/lib/guided/roadmap-types'
import './guided-mode.css'

export function GuidedModePage() {
  const { id } = useParams<{ id: string }>()
  const subsystemId = id ? parseInt(id, 10) : NaN
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const [svgError, setSvgError] = useState<string | null>(null)
  const mapRef = useRef<GuidedTestingMapHandle | null>(null)

  const { state, openDevice, closeDevice, skipDevice } = useGuidedSession(subsystemId)

  const [roadmaps, setRoadmaps] = useState<Roadmap[]>([])
  const [selectedRoadmapId, setSelectedRoadmapId] = useState<number | null>(null)
  const [flowMode, setFlowMode] = useState<'scada' | 'roadmap'>('scada')
  const [isPulling, setIsPulling] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const roadmap = useRoadmapSession()
  const mapContainerRef = useRef<HTMLDivElement | null>(null)

  // Load cached roadmaps for this subsystem
  useEffect(() => {
    if (!subsystemId || isNaN(subsystemId)) return
    let cancelled = false
    fetch(`/api/roadmap?subsystemId=${subsystemId}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setRoadmaps(d.roadmaps ?? []) })
      .catch(err => { console.error('[Roadmap] load:', err); if (!cancelled) setRoadmaps([]) })
    return () => { cancelled = true }
  }, [subsystemId])

  async function pullRoadmaps() {
    setIsPulling(true)
    try {
      await fetch('/api/cloud/pull-roadmap', { method: 'POST' })
      const refreshed = await (await fetch(`/api/roadmap?subsystemId=${subsystemId}`)).json()
      setRoadmaps(refreshed.roadmaps ?? [])
    } catch (e) { console.error('[Roadmap] pull failed:', e) }
    finally { setIsPulling(false) }
  }

  function startSelectedRoadmap(id: number) {
    const r = roadmaps.find(x => x.id === id)
    if (!r) return
    setSelectedRoadmapId(id)
    roadmap.start(r.id, r.stepsJson, r.pathJson ?? null)
  }

  const currentStep = roadmap.state.status === 'playing'
    ? roadmap.state.steps[roadmap.state.currentStepIndex] ?? null
    : null

  // Auto-advance check: whenever device/IO state changes, see if the current
  // step's advance condition is met.
  useEffect(() => {
    if (!currentStep) return
    let cancelled = false
    const dev = state.devices.find(d => d.deviceName === currentStep.deviceName)
    const deviceState = dev?.state ?? 'untested'
    if (currentStep.kind === 'io' && currentStep.ioName) {
      // Fetch the device's IOs and look up the target IO's result
      fetch(`/api/guided/devices/${encodeURIComponent(currentStep.deviceName)}?subsystemId=${subsystemId}`)
        .then(r => r.json())
        .then(d => {
          if (cancelled) return
          const io = (d.ios ?? []).find((x: any) => x.name === currentStep.ioName)
          const ioResult = (io?.result as 'Passed' | 'Failed' | null) ?? null
          if (shouldAdvanceStep(currentStep, deviceState, ioResult)) {
            roadmap.advance(ioResult === 'Failed' ? 'failed' : 'passed')
          }
        })
        .catch(() => {})
      return () => { cancelled = true }
    }
    if (shouldAdvanceStep(currentStep, deviceState, null)) {
      roadmap.advance(deviceState === 'failed' ? 'failed' : 'passed')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.deviceName, currentStep?.ioName, currentStep?.kind, state.devices, subsystemId])

  // When roadmap is active, force-select the current step's device and pan to it
  useEffect(() => {
    if (!currentStep) return
    openDevice(currentStep.deviceName)
    mapRef.current?.centerOnDevice(currentStep.deviceName)
  }, [currentStep?.deviceName, openDevice])

  // Locked-device set for the map
  const lockedDevices = currentStep
    ? new Set<string>([currentStep.deviceName])
    : null

  // Load SVG once we know the subsystem
  useEffect(() => {
    if (!subsystemId || isNaN(subsystemId)) return
    let cancelled = false
    setSvgError(null)
    fetch(`/api/maps/subsystem/${subsystemId}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then(text => { if (!cancelled) setSvgMarkup(text) })
      .catch(err => {
        console.error('[GuidedModePage] Failed to load SVG:', err)
        if (!cancelled) {
          setSvgMarkup('')
          setSvgError(err.message ?? 'Unknown error')
        }
      })
    return () => { cancelled = true }
  }, [subsystemId])

  const currentTarget = useMemo(() => findCurrentTarget(state.devices), [state.devices])
  const selectedDevice = state.selectedDevice
    ? state.devices.find(d => d.deviceName === state.selectedDevice) ?? null
    : null

  // Auto-select the current target on first load so the panel isn't empty.
  // Once user explicitly closes or picks something else, leave them in control.
  const hasAutoSelectedRef = useRef(false)
  useEffect(() => {
    if (hasAutoSelectedRef.current) return
    if (!currentTarget || state.selectedDevice !== null) return
    if (state.devices.length === 0) return
    hasAutoSelectedRef.current = true
    openDevice(currentTarget.deviceName)
  }, [currentTarget, state.devices.length, state.selectedDevice, openDevice])

  // Aggregate progress for header
  const progress = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const d of state.devices) {
      totals[d.state] = (totals[d.state] ?? 0) + 1
    }
    const completed = (totals.passed ?? 0) + (totals.failed ?? 0)
    const total = state.devices.length
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0
    return {
      completed, total, percent,
      passed: totals.passed ?? 0,
      failed: totals.failed ?? 0,
      inProgress: totals.in_progress ?? 0,
      skipped: totals.skipped ?? 0,
    }
  }, [state.devices])

  const isCurrent =
    !!selectedDevice && !!currentTarget && selectedDevice.deviceName === currentTarget.deviceName

  function selectCurrent() {
    if (!currentTarget) return
    mapRef.current?.centerOnDevice(currentTarget.deviceName)
    openDevice(currentTarget.deviceName)
  }

  function recenter() {
    const target = selectedDevice ?? currentTarget
    if (!target) return
    mapRef.current?.centerOnDevice(target.deviceName)
  }

  // We intentionally do NOT auto-pan whenever selectedDevice changes —
  // that would yank the map every time the user clicks somewhere else.
  // Instead, panning happens explicitly via:
  //   - the "Show on map" buttons in the panel
  //   - the recenter button
  //   - the "Back to current target" link
  //   - the first-load auto-zoom inside the map component itself

  if (!subsystemId || isNaN(subsystemId)) {
    return (
      <div className="gm-root">
        <div className="gm-loading">Invalid subsystem id</div>
      </div>
    )
  }

  return (
    <div className="gm-root">
      {/* ─────────── HEADER ─────────── */}
      <header className="gm-header">
        <div className="gm-header-left">
          <Link to={`/commissioning/${subsystemId}`} className="gm-back">
            <ArrowLeft size={14} /> Back
          </Link>
          <div className="gm-title-block">
            <div className="gm-title">Subsystem {subsystemId}</div>
            <div className="gm-title-meta">Guided Commissioning</div>
          </div>
        </div>

        <div className="gm-progress-wrap">
          <div className="gm-progress-stats">
            <strong>{progress.completed}</strong> / {progress.total} devices
          </div>
          <div className="gm-progress-track" aria-label="Progress">
            <div className="gm-progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="gm-progress-stats">{progress.percent}%</div>
        </div>

        <div className="gm-header-right">
          <FlowModeChip
            flowMode={flowMode}
            setFlowMode={setFlowMode}
            roadmaps={roadmaps}
            selectedRoadmapId={selectedRoadmapId}
            onSelectRoadmap={startSelectedRoadmap}
            onPullRoadmaps={pullRoadmaps}
            isPulling={isPulling}
          />
          <ThemeToggleChip />
          <button
            type="button"
            className="gm-icon-btn"
            onClick={() => setPanelCollapsed(c => !c)}
            title={panelCollapsed ? 'Show side panel' : 'Hide side panel'}
            aria-label={panelCollapsed ? 'Show side panel' : 'Hide side panel'}
          >
            {panelCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
          </button>
        </div>
      </header>

      {/* ─────────── BODY ─────────── */}
      <div className={`gm-body${panelCollapsed ? ' gm-body--panel-hidden' : ''}`}>
        {/* MAP PANE */}
        <div className="gm-map">
          <div className="gm-map-stage" ref={mapContainerRef}>
            {svgMarkup === null ? (
              <div className="gm-loading">
                <div className="gm-spinner" />
                <div>Loading map</div>
              </div>
            ) : svgMarkup === '' ? (
              <div className="gm-loading" style={{ color: 'var(--gm-text-faint)' }}>
                <div>No map available</div>
                {svgError && (
                  <div style={{ fontSize: 11, marginTop: 4, letterSpacing: '0.04em', textTransform: 'none' }}>
                    {svgError}
                  </div>
                )}
              </div>
            ) : (
              <GuidedTestingMap
                ref={mapRef}
                svgMarkup={svgMarkup}
                devices={state.devices}
                activeDevice={selectedDevice ?? currentTarget}
                onDeviceClick={openDevice}
                lockedDevices={lockedDevices}
              />
            )}
          </div>

          {/* Legend overlay */}
          {svgMarkup && state.devices.length > 0 && (
            <div className="gm-map-overlay gm-legend">
              <div className="gm-legend-row">
                <span className="gm-legend-swatch" data-state="current" />
                <span>Current target</span>
              </div>
              <div className="gm-legend-row">
                <span className="gm-legend-swatch" data-state="passed" />
                <span>Passed</span>
              </div>
              <div className="gm-legend-row">
                <span className="gm-legend-swatch" data-state="in_progress" />
                <span>In progress</span>
              </div>
              <div className="gm-legend-row">
                <span className="gm-legend-swatch" data-state="failed" />
                <span>Failed</span>
              </div>
              <div className="gm-legend-row">
                <span className="gm-legend-swatch" data-state="skipped" />
                <span>Skipped</span>
              </div>
              <div className="gm-legend-row">
                <span className="gm-legend-swatch" data-state="untested" />
                <span>Untested</span>
              </div>
            </div>
          )}

          {/* Recenter button */}
          {svgMarkup && (selectedDevice || currentTarget) && (
            <button className="gm-map-overlay gm-recenter" onClick={recenter}>
              <Crosshair size={14} />
              {selectedDevice ? 'Recenter' : 'Find target'}
            </button>
          )}

          {/* Roadmap path overlay — arrows drawn on the map */}
          {flowMode === 'roadmap' && (roadmap.state.status === 'playing' || roadmap.state.status === 'complete') && (
            <RoadmapPathOverlay
              path={roadmap.state.path}
              currentStepIndex={roadmap.state.currentStepIndex}
              containerRef={mapContainerRef}
            />
          )}
        </div>

        {/* PANEL — also hosts the roadmap step directive when playing */}
        <DeviceTestPanel
          device={selectedDevice}
          currentTarget={currentTarget}
          subsystemId={subsystemId}
          isCurrent={isCurrent}
          onSelectCurrent={selectCurrent}
          onClose={closeDevice}
          onCenterOnDevice={(name) => mapRef.current?.centerOnDevice(name)}
          onSkip={(name) => {
            skipDevice(name)
            window.setTimeout(() => {
              const next = findCurrentTarget(state.devices.filter(d => d.deviceName !== name))
              if (next) openDevice(next.deviceName)
            }, 0)
          }}
          roadmapActive={flowMode === 'roadmap' && roadmap.state.status !== 'idle' && roadmap.state.status !== 'cancelled'}
          roadmapStatus={roadmap.state.status}
          roadmapStep={currentStep}
          roadmapStepIndex={roadmap.state.currentStepIndex}
          roadmapTotalSteps={roadmap.state.steps.length}
          roadmapResults={{
            passed: roadmap.state.stepResults.filter(r => r.result === 'passed').length,
            failed: roadmap.state.stepResults.filter(r => r.result === 'failed').length,
            skipped: roadmap.state.stepResults.filter(r => r.result === 'skipped').length,
          }}
          onRoadmapPass={() => roadmap.advance('passed')}
          onRoadmapFail={() => roadmap.advance('failed')}
          onRoadmapSkip={() => roadmap.skipCurrent()}
          onRoadmapPrevious={() => roadmap.previous()}
          onRoadmapEnd={() => { roadmap.end(); setFlowMode('scada'); setSelectedRoadmapId(null) }}
        />
      </div>
    </div>
  )
}

/**
 * Lightweight theme toggle sized to match the cockpit chrome. Uses next-themes
 * (already wired in App.tsx). Note: Guided Mode itself is intentionally
 * dark-only — the toggle changes the rest of the app's theme, so the operator
 * sees the new theme when they navigate back to the SCADA grid or other pages.
 */
function ThemeToggleChip() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <span className="gm-icon-btn" aria-hidden />
  const current = (theme === 'system' ? resolvedTheme : theme) ?? 'dark'
  const next = current === 'light' ? 'dark' : 'light'
  return (
    <button
      type="button"
      className="gm-icon-btn"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
    >
      {current === 'light' ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  )
}

function FlowModeChip({ flowMode, setFlowMode, roadmaps, selectedRoadmapId, onSelectRoadmap, onPullRoadmaps, isPulling }: {
  flowMode: 'scada' | 'roadmap'
  setFlowMode: (m: 'scada' | 'roadmap') => void
  roadmaps: Roadmap[]
  selectedRoadmapId: number | null
  onSelectRoadmap: (id: number) => void
  onPullRoadmaps: () => void
  isPulling: boolean
}) {
  const [open, setOpen] = useState(false)
  const label = flowMode === 'roadmap' ? 'Roadmap' : 'SCADA order'
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)} className="gm-flow-chip" title="Ordering algorithm">
        <GitBranch size={11} />
        <span>Flow: {label}</span>
        <ChevronDown size={11} style={{ opacity: 0.6 }} />
      </button>
      {open && (
        <div className="gm-flow-menu" onMouseLeave={() => setOpen(false)}>
          <div className="gm-flow-item" data-active={flowMode === 'scada'} onClick={() => { setFlowMode('scada'); setOpen(false) }}>
            <span className="gm-flow-dot" /><span>SCADA document order</span>
          </div>
          <div className="gm-flow-item" data-active={flowMode === 'roadmap'} onClick={() => setFlowMode('roadmap')}>
            <span className="gm-flow-dot" /><span>Roadmap</span>
          </div>
          {flowMode === 'roadmap' && (
            <RoadmapPicker
              roadmaps={roadmaps}
              selectedRoadmapId={selectedRoadmapId}
              onSelect={onSelectRoadmap}
              onPull={onPullRoadmaps}
              isPulling={isPulling}
            />
          )}
        </div>
      )}
    </div>
  )
}
