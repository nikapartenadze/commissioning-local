import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Crosshair, GitBranch, ChevronDown } from 'lucide-react'
import { useGuidedSession } from '@/lib/guided/use-guided-session'
import { findCurrentTarget } from '@/lib/guided/device-state'
import { GuidedTestingMap, type GuidedTestingMapHandle } from './guided-testing-map'
import { DeviceTestPanel } from './device-test-panel'
import './guided-mode.css'

export function GuidedModePage() {
  const { id } = useParams<{ id: string }>()
  const subsystemId = id ? parseInt(id, 10) : NaN
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const [svgError, setSvgError] = useState<string | null>(null)
  const mapRef = useRef<GuidedTestingMapHandle | null>(null)

  const { state, openDevice, closeDevice, skipDevice } = useGuidedSession(subsystemId)

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
          <FlowModeChip />
          <div className="gm-prototype-badge">Prototype · No Writes</div>
        </div>
      </header>

      {/* ─────────── BODY ─────────── */}
      <div className="gm-body">
        {/* MAP PANE */}
        <div className="gm-map">
          <div className="gm-map-stage">
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
        </div>

        {/* PANEL */}
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
            // After skip, auto-select the new current target so the panel stays useful
            window.setTimeout(() => {
              const next = findCurrentTarget(state.devices.filter(d => d.deviceName !== name))
              if (next) openDevice(next.deviceName)
            }, 0)
          }}
        />
      </div>
    </div>
  )
}

/**
 * Stub for the ordering-mode picker. The traversal algorithm is currently
 * SCADA document order (the order devices appear in the SVG file). Future
 * modes will let operators sequence by device type ("VFDs first"), by
 * failure history ("retest failed"), or follow a custom route.
 *
 * Rendered as a non-interactive chip in Phase 1 — the menu opens on click
 * but only the current mode is enabled. Wiring multiple algorithms is a
 * Phase 2 task once we know which modes operators actually want.
 */
function FlowModeChip() {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="gm-flow-chip"
        title="Ordering algorithm"
      >
        <GitBranch size={11} />
        <span>Flow: SCADA order</span>
        <ChevronDown size={11} style={{ opacity: 0.6 }} />
      </button>
      {open && (
        <div className="gm-flow-menu" onMouseLeave={() => setOpen(false)}>
          <div className="gm-flow-item" data-active="true">
            <span className="gm-flow-dot" />
            <span>SCADA document order</span>
            <span className="gm-flow-hint">current</span>
          </div>
          <div className="gm-flow-item" data-disabled="true">
            <span className="gm-flow-dot" />
            <span>By device type</span>
            <span className="gm-flow-hint">soon</span>
          </div>
          <div className="gm-flow-item" data-disabled="true">
            <span className="gm-flow-dot" />
            <span>Failed-first retest</span>
            <span className="gm-flow-hint">soon</span>
          </div>
          <div className="gm-flow-item" data-disabled="true">
            <span className="gm-flow-dot" />
            <span>Custom route</span>
            <span className="gm-flow-hint">soon</span>
          </div>
        </div>
      )}
    </div>
  )
}
