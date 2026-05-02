import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, X, Activity, Zap, AlertTriangle, SkipForward, MapPin } from 'lucide-react'
import type { Device, IoSummary } from '@/lib/guided/types'

type IoResult = 'Passed' | 'Failed' | null

interface SwapEvent {
  expectedIoName: string
  actualIoName: string
  actualIoId: number
}

interface Props {
  device: Device | null
  /** Recommended next device — used for the "no device selected" empty state. */
  currentTarget: Device | null
  subsystemId: number
  /** Whether the selected device is also the current recommended target. */
  isCurrent: boolean
  onSelectCurrent: () => void
  onClose: () => void
  onSkip: (deviceName: string) => void
  /** Pan/zoom the SVG map to the named device. */
  onCenterOnDevice: (deviceName: string) => void
}

/**
 * Right-pane command surface. Always mounted (no drawer animation):
 *  - empty state when nothing is selected
 *  - hero card for the current IO with PASS / FAIL / SKIP / SIMULATE
 *  - inline signal watcher (mocked; real PLC streaming wires in Phase 2)
 *  - swap-detection banner is launched from this pane via "Simulate swap"
 *  - full IO list below the hero
 *
 * PHASE 1 ONLY: every interaction is in-memory. No DB writes, no
 * /api/test calls, no PLC writes. The simulate buttons exist so we can
 * walk the auto-pass / swap-detect flows visually before wiring them.
 */
export function DeviceTestPanel({
  device,
  currentTarget,
  subsystemId,
  isCurrent,
  onSelectCurrent,
  onClose,
  onSkip,
  onCenterOnDevice,
}: Props) {
  const [ios, setIos] = useState<IoSummary[] | null>(null)
  const [localResults, setLocalResults] = useState<Record<number, IoResult>>({})
  const [swap, setSwap] = useState<SwapEvent | null>(null)
  const [flashIoId, setFlashIoId] = useState<number | null>(null)

  // Reset local state whenever device changes
  useEffect(() => {
    setIos(null)
    setLocalResults({})
    setSwap(null)
    if (!device) return
    let cancelled = false
    fetch(`/api/guided/devices/${encodeURIComponent(device.deviceName)}?subsystemId=${subsystemId}`)
      .then(r => r.json())
      .then(data => { if (!cancelled) setIos(data.ios ?? []) })
      .catch(err => {
        console.error('[DeviceTestPanel] Failed to load device IOs:', err)
        if (!cancelled) setIos([])
      })
    return () => { cancelled = true }
  }, [device?.deviceName, subsystemId])

  // Keyboard shortcuts (P / F / S / N) — desktop dev convenience
  useEffect(() => {
    if (!device) return
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      const k = e.key.toLowerCase()
      if (k === 'p' && currentIo) markResult(currentIo.id, 'Passed')
      else if (k === 'f' && currentIo) markResult(currentIo.id, 'Failed')
      else if (k === 's' && device) onSkip(device.deviceName)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function effectiveResult(io: IoSummary): IoResult {
    if (io.id in localResults) return localResults[io.id]
    return io.result
  }

  function markResult(ioId: number, result: IoResult) {
    setLocalResults(s => ({ ...s, [ioId]: result }))
    setFlashIoId(ioId)
    window.setTimeout(() => setFlashIoId(p => (p === ioId ? null : p)), 600)
  }

  const currentIo = useMemo<IoSummary | null>(() => {
    if (!ios) return null
    return ios.find(io => effectiveResult(io) === null) ?? null
  }, [ios, localResults])

  const counts = useMemo(() => {
    if (!ios) return { passed: 0, failed: 0, total: 0 }
    let p = 0, f = 0
    for (const io of ios) {
      const r = effectiveResult(io)
      if (r === 'Passed') p++
      else if (r === 'Failed') f++
    }
    return { passed: p, failed: f, total: ios.length }
  }, [ios, localResults])

  // ================== EMPTY STATE — no device selected ==================
  if (!device) {
    return (
      <aside className="gm-panel">
        <div className="gm-panel-head">
          <div className="gm-panel-eyebrow" data-state="empty">No device selected</div>
          <div className="gm-panel-device" style={{ fontSize: 18, color: 'var(--gm-text-dim)' }}>
            {currentTarget ? 'Begin guided testing' : 'No work suggested'}
          </div>
        </div>

        {currentTarget ? (
          <div className="gm-card-empty">
            <div className="gm-card-title">Next on the list</div>
            <div className="gm-card-body">
              The next device suggested by the SCADA traversal is{' '}
              <strong style={{ color: 'var(--gm-text)' }}>{currentTarget.deviceName}</strong>.
              {' '}You can also tap any colored device on the map to start there instead.
            </div>
            <button className="gm-cta" onClick={onSelectCurrent}>
              Begin <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <div className="gm-card-empty">
            <div className="gm-card-title">No untested work remains</div>
            <div className="gm-card-body">
              Every device on this subsystem is either complete, skipped, or unmapped.
              You can still pick any device on the map to inspect its IOs.
            </div>
          </div>
        )}
      </aside>
    )
  }

  // ================== ACTIVE STATE ==================
  const allDone = ios !== null && ios.length > 0 && currentIo === null
  const noIos = ios !== null && ios.length === 0

  return (
    <aside className="gm-panel">
      {/* Header */}
      <div className="gm-panel-head">
        <div className="gm-panel-eyebrow" data-state={isCurrent ? undefined : 'browsing'}>
          {isCurrent ? 'Now Testing' : 'Browsing'}
        </div>
        <button
          type="button"
          className="gm-panel-device gm-panel-device-btn"
          onClick={() => onCenterOnDevice(device.deviceName)}
          title="Show on map"
        >
          {device.deviceName}
          <MapPin size={14} className="gm-panel-pin" />
        </button>
        <div className="gm-panel-stats">
          <span className="gm-panel-stat">
            <strong>{counts.total}</strong> IOs
          </span>
          {counts.passed > 0 && (
            <span className="gm-panel-stat gm-panel-stat-passed">
              <strong>{counts.passed}</strong> passed
            </span>
          )}
          {counts.failed > 0 && (
            <span className="gm-panel-stat gm-panel-stat-failed">
              <strong>{counts.failed}</strong> failed
            </span>
          )}
        </div>
        {!isCurrent && currentTarget && (
          <button className="gm-return-link" onClick={onSelectCurrent}>
            ← Back to current target ({currentTarget.deviceName})
          </button>
        )}
      </div>

      {/* Body — hero card + IO list */}
      {ios === null ? (
        <div className="gm-loading">
          <div className="gm-spinner" />
          <div>Loading IOs</div>
        </div>
      ) : noIos ? (
        <div className="gm-card-empty">
          <div className="gm-card-title">No IOs configured</div>
          <div className="gm-card-body">
            This device exists in the SCADA map but has no IOs in the current subsystem snapshot.
          </div>
          <button className="gm-cta" onClick={() => onSkip(device.deviceName)}>
            Skip device <ArrowRight size={14} />
          </button>
        </div>
      ) : allDone ? (
        <div className="gm-card-done">
          <div className="gm-card-title">
            <Check size={18} style={{ display: 'inline', verticalAlign: '-3px', marginRight: 6 }} />
            Device complete
          </div>
          <div className="gm-card-body">
            All {counts.total} IOs accounted for ({counts.passed} passed, {counts.failed} failed).
          </div>
          {currentTarget && currentTarget.deviceName !== device.deviceName && (
            <button className="gm-cta" onClick={onSelectCurrent}>
              Next: {currentTarget.deviceName} <ArrowRight size={14} />
            </button>
          )}
          <button
            className="gm-secondary"
            onClick={onClose}
            style={{ marginTop: 12, marginLeft: 0, width: 'auto', padding: '0 14px' }}
          >
            Close
          </button>
        </div>
      ) : currentIo ? (
        <>
          {/* Hero IO card — clickable to pan/zoom map to this device */}
          <button
            type="button"
            className="gm-hero gm-hero-btn"
            onClick={() => onCenterOnDevice(device.deviceName)}
            title="Show on map"
          >
            <div className="gm-hero-eyebrow-row">
              <span className="gm-hero-eyebrow">Current IO</span>
              <span className="gm-hero-locate"><MapPin size={11} /> Show on map</span>
            </div>
            <div className="gm-hero-name">{currentIo.name}</div>
            {currentIo.description && (
              <div className="gm-hero-desc">{currentIo.description}</div>
            )}

            <div className="gm-signal">
              <span className="gm-signal-dot" />
              <span className="gm-signal-text">
                Watching for signal on <strong>{shortIoCode(currentIo.name)}</strong>…
              </span>
            </div>
          </button>

          {/* Primary actions */}
          <div className="gm-actions">
            <button className="gm-action gm-action-pass" onClick={() => markResult(currentIo.id, 'Passed')}>
              <Check size={18} /> Pass
            </button>
            <button className="gm-action gm-action-fail" onClick={() => markResult(currentIo.id, 'Failed')}>
              <X size={18} /> Fail
            </button>
          </div>

          {/* Secondary: skip / simulate */}
          <div className="gm-secondary-row">
            <button className="gm-secondary" onClick={() => onSkip(device.deviceName)}>
              <SkipForward size={12} /> Skip device
            </button>
            <button
              className="gm-secondary"
              data-variant="amber"
              onClick={() => simulateSwap(currentIo, ios, setSwap)}
            >
              <AlertTriangle size={12} /> Simulate swap
            </button>
          </div>

          <div className="gm-keys-hint">
            <span><span className="gm-key">P</span>pass</span>
            <span><span className="gm-key">F</span>fail</span>
            <span><span className="gm-key">S</span>skip device</span>
          </div>
        </>
      ) : null}

      {/* IO list */}
      {ios !== null && ios.length > 0 && !allDone && (
        <div className="gm-iolist-section">
          <div className="gm-iolist-head">
            <span>Device IOs</span>
            <span className="gm-iolist-count">{counts.total}</span>
          </div>
          <div className="gm-iolist">
            {ios.map(io => {
              const r = effectiveResult(io)
              const isCurr = currentIo?.id === io.id
              const flashing = flashIoId === io.id
              const state = r === 'Passed' ? 'passed'
                : r === 'Failed' ? 'failed'
                : isCurr ? 'current'
                : 'pending'
              const Icon = r === 'Passed' ? Check
                : r === 'Failed' ? X
                : isCurr ? Activity
                : Zap
              return (
                <div
                  key={io.id}
                  className="gm-io"
                  data-current={isCurr ? 'true' : undefined}
                  style={flashing ? {
                    background: r === 'Passed'
                      ? 'rgba(34, 197, 94, 0.18)'
                      : 'rgba(239, 68, 68, 0.18)',
                    transition: 'background 600ms',
                  } : undefined}
                >
                  <span className="gm-io-icon" data-state={state}>
                    <Icon size={state === 'pending' ? 12 : 14} />
                  </span>
                  <div className="gm-io-text">
                    <div className="gm-io-name">{shortIoCode(io.name)}</div>
                    {io.description && <div className="gm-io-desc">{io.description}</div>}
                  </div>
                  {state !== 'pending' && (
                    <span className="gm-io-tag" data-state={state}>
                      {state === 'current' ? 'Active' : state}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Swap banner (rendered into map area via portal would be cleaner;
          for now it sits on top via fixed position; map has z-index lower) */}
      {swap && currentIo && (
        <SwapBanner
          swap={swap}
          onAccept={() => {
            // Accept swap: actual IO passes, expected IO fails (with swap comment in real impl)
            markResult(currentIo.id, 'Failed')
            markResult(swap.actualIoId, 'Passed')
            setSwap(null)
          }}
          onDismiss={() => setSwap(null)}
        />
      )}
    </aside>
  )
}

/** Render the rightmost segment of a tag path so the hero is readable on tablet. */
function shortIoCode(name: string): string {
  const idx = name.lastIndexOf(':')
  return idx >= 0 ? name.slice(idx + 1) : name
}

function simulateSwap(
  current: IoSummary,
  ios: IoSummary[],
  setSwap: (s: SwapEvent | null) => void,
) {
  const candidate = ios.find(io => io.id !== current.id && io.result === null)
  if (!candidate) return
  setSwap({
    expectedIoName: shortIoCode(current.name),
    actualIoName: shortIoCode(candidate.name),
    actualIoId: candidate.id,
  })
}

interface SwapBannerProps {
  swap: SwapEvent
  onAccept: () => void
  onDismiss: () => void
}
function SwapBanner({ swap, onAccept, onDismiss }: SwapBannerProps) {
  return (
    <div className="gm-map-overlay gm-swap-banner">
      <div className="gm-swap-icon">
        <AlertTriangle size={18} />
      </div>
      <div className="gm-swap-text">
        <div className="gm-swap-title">Possible Swap Detected</div>
        <div className="gm-swap-detail">
          Expected <strong>{swap.expectedIoName}</strong>, but signal fired on{' '}
          <strong>{swap.actualIoName}</strong>.
        </div>
      </div>
      <div className="gm-swap-actions">
        <button className="gm-swap-btn" onClick={onDismiss}>Dismiss</button>
        <button className="gm-swap-btn" data-variant="accept" onClick={onAccept}>
          Accept Swap
        </button>
      </div>
    </div>
  )
}
