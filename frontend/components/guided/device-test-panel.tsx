import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, X, Activity, Zap, AlertTriangle, SkipForward, MapPin, ChevronRight, ChevronLeft, LogOut, RotateCcw, Power } from 'lucide-react'
import type { Device, IoSummary } from '@/lib/guided/types'
import type { RoadmapStep } from '@/lib/guided/roadmap-types'
import { useUser } from '@/lib/user-context'

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
  /** Unconditional next-device navigation. Parent walks state.devices
   *  forward from the current device, regardless of pass/fail state.
   *  Null when there is no next device (already at the end). */
  onNextDevice?: () => void
  onPrevDevice?: () => void
  nextDeviceName?: string | null
  prevDeviceName?: string | null

  /* ──────────────── Roadmap-mode props (optional) ──────────────── */
  /** True when the operator is running an authored roadmap (not free SCADA flow). */
  roadmapActive?: boolean
  /** Reducer status — used to swap the body for the completion summary. */
  roadmapStatus?: 'idle' | 'playing' | 'complete' | 'cancelled'
  /** The directive shown at the top of the panel while playing. */
  roadmapStep?: RoadmapStep | null
  /** 0-based index used to render "STEP n / m". */
  roadmapStepIndex?: number
  roadmapTotalSteps?: number
  roadmapResults?: { passed: number; failed: number; skipped: number }
  onRoadmapPass?: () => void
  onRoadmapFail?: () => void
  onRoadmapSkip?: () => void
  onRoadmapPrevious?: () => void
  onRoadmapEnd?: () => void

  /** Fired after a Pass/Fail/Clear is persisted so the parent can refetch
   *  /api/guided/devices and let the map recolor from DB truth. */
  onResultsChanged?: () => void
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
  onNextDevice,
  onPrevDevice,
  nextDeviceName = null,
  prevDeviceName = null,
  roadmapActive = false,
  roadmapStatus = 'idle',
  roadmapStep = null,
  roadmapStepIndex = 0,
  roadmapTotalSteps = 0,
  roadmapResults = { passed: 0, failed: 0, skipped: 0 },
  onRoadmapPass,
  onRoadmapFail,
  onRoadmapSkip,
  onRoadmapPrevious,
  onRoadmapEnd,
  onResultsChanged,
}: Props) {
  const { currentUser } = useUser()
  const [ios, setIos] = useState<IoSummary[] | null>(null)
  const [localResults, setLocalResults] = useState<Record<number, IoResult>>({})
  const [swap, setSwap] = useState<SwapEvent | null>(null)
  const [flashIoId, setFlashIoId] = useState<number | null>(null)
  const [pendingIoId, setPendingIoId] = useState<number | null>(null)
  const [persistError, setPersistError] = useState<string | null>(null)

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

  // Re-fetch this device's IOs from the server. Used after a successful
  // persistence so the row reflects what's actually in the DB rather than
  // our optimistic localResults shadow.
  async function reloadDeviceIos() {
    if (!device) return
    try {
      const r = await fetch(`/api/guided/devices/${encodeURIComponent(device.deviceName)}?subsystemId=${subsystemId}`)
      const data = await r.json()
      setIos(data.ios ?? [])
    } catch (err) {
      console.error('[DeviceTestPanel] Failed to reload device IOs:', err)
    }
  }

  /** Mark an IO Passed/Failed AND persist to the local DB (POST /api/guided/test).
   *  Optimistic: shows the colour change immediately, then reconciles with
   *  the server response. On failure, rolls back and surfaces a banner. */
  async function markResult(ioId: number, result: IoResult) {
    if (result === null) { clearResult(ioId); return }
    // Optimistic flash + colour
    setLocalResults(s => ({ ...s, [ioId]: result }))
    setFlashIoId(ioId)
    window.setTimeout(() => setFlashIoId(p => (p === ioId ? null : p)), 600)
    setPendingIoId(ioId)
    setPersistError(null)
    try {
      const r = await fetch('/api/guided/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ioId,
          result,
          currentUser: currentUser?.fullName,
        }),
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.error ?? `HTTP ${r.status}`)
      }
      // Reconcile: pull what the server saved + drop the local override
      await reloadDeviceIos()
      setLocalResults(s => { const n = { ...s }; delete n[ioId]; return n })
      onResultsChanged?.()
    } catch (err) {
      console.error('[DeviceTestPanel] markResult failed:', err)
      setLocalResults(s => { const n = { ...s }; delete n[ioId]; return n })
      setPersistError(err instanceof Error ? err.message : 'Failed to save')
      window.setTimeout(() => setPersistError(null), 4000)
    } finally {
      setPendingIoId(p => (p === ioId ? null : p))
    }
  }

  /** Clear a previously-marked IO back to untested. Persists via the existing
   *  POST /api/ios/:id/reset (which also wipes Comments and emits a sync). */
  async function clearResult(ioId: number) {
    setLocalResults(s => ({ ...s, [ioId]: null }))
    setPendingIoId(ioId)
    setPersistError(null)
    try {
      const r = await fetch('/api/guided/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ioId, currentUser: currentUser?.fullName }),
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.error ?? `HTTP ${r.status}`)
      }
      await reloadDeviceIos()
      setLocalResults(s => { const n = { ...s }; delete n[ioId]; return n })
      onResultsChanged?.()
    } catch (err) {
      console.error('[DeviceTestPanel] clearResult failed:', err)
      setPersistError(err instanceof Error ? err.message : 'Failed to clear')
      window.setTimeout(() => setPersistError(null), 4000)
    } finally {
      setPendingIoId(p => (p === ioId ? null : p))
    }
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

  // ----------------------------------------------------------------
  // Auto-advance between devices.
  //
  // Without this, the user has to do "Pass … Pass … Pass … Close →
  // Begin" every time they finish a device. The "Pass" auto-advances
  // within a device (currentIo is the first untested IO), but the
  // device → device transition needs a manual two-tap.
  //
  // When the user JUST finished marking the last IO in this device
  // AND the SCADA traversal suggests a next device that ISN'T this
  // one, we auto-jump after a brief beat (900 ms) — long enough to
  // read the "Device complete" confirmation, short enough to feel
  // snappy. The user can hit Close during the window to cancel.
  //
  // Guards:
  //  - localResults must have at least one entry → only fires when
  //    the user actually marked something this session, NOT when
  //    they re-opened an already-complete device just to inspect it
  //  - the next device must be different → no infinite re-select
  //  - skip when there's no next target → end of run, just show the
  //    "Device complete" card
  // ----------------------------------------------------------------
  const allDoneNow =
    ios !== null && ios.length > 0 && ios.every(io => effectiveResult(io) !== null)
  const userMarkedSomething = Object.keys(localResults).length > 0
  const nextDeviceDifferent =
    currentTarget != null && device != null && currentTarget.deviceName !== device.deviceName

  useEffect(() => {
    if (!allDoneNow || !nextDeviceDifferent || !userMarkedSomething) return
    const t = window.setTimeout(() => onSelectCurrent(), 900)
    return () => window.clearTimeout(t)
  }, [allDoneNow, nextDeviceDifferent, userMarkedSomething, onSelectCurrent])

  // ================== ROADMAP COMPLETE — replaces the entire panel ==================
  if (roadmapActive && roadmapStatus === 'complete') {
    return (
      <aside className="gm-panel">
        <RoadmapCompleteCard
          total={roadmapTotalSteps}
          passed={roadmapResults.passed}
          failed={roadmapResults.failed}
          skipped={roadmapResults.skipped}
          onEnd={onRoadmapEnd ?? (() => {})}
        />
      </aside>
    )
  }

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
      {/* Roadmap directive (replaces bottom banner AND the device head when playing) */}
      {roadmapActive && roadmapStatus === 'playing' && roadmapStep && (
        <RoadmapStepDirective
          step={roadmapStep}
          currentIndex={roadmapStepIndex}
          totalSteps={roadmapTotalSteps}
          device={device}
          counts={counts}
          onCenterOnDevice={onCenterOnDevice}
          onPass={onRoadmapPass ?? (() => {})}
          onFail={onRoadmapFail ?? (() => {})}
          onSkip={onRoadmapSkip ?? (() => {})}
          onPrevious={onRoadmapPrevious ?? (() => {})}
          onEnd={onRoadmapEnd ?? (() => {})}
          canGoPrevious={roadmapStepIndex > 0}
        />
      )}

      {/* Header — hidden when the roadmap directive is driving the panel
          (the directive carries the device chip + IO counts inline) */}
      {!(roadmapActive && roadmapStatus === 'playing') && (
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
        {/* Unconditional device navigation — walks state.devices regardless
            of pass/fail state, so the operator is never stuck on a single
            device with no Next button. */}
        <div className="gm-device-nav">
          <button
            type="button"
            className="gm-device-nav-btn"
            onClick={() => onPrevDevice?.()}
            disabled={!onPrevDevice || !prevDeviceName}
            title={prevDeviceName ? `Previous device: ${prevDeviceName}` : 'No previous device'}
          >
            <ChevronLeft size={14} />
            <span>Prev</span>
          </button>
          <button
            type="button"
            className="gm-device-nav-btn gm-device-nav-btn--next"
            onClick={() => onNextDevice?.()}
            disabled={!onNextDevice || !nextDeviceName}
            title={nextDeviceName ? `Next device: ${nextDeviceName}` : 'No next device'}
          >
            <span>{nextDeviceName ? `Next · ${nextDeviceName}` : 'Next'}</span>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      )}

      {/* Body — hero card + IO list */}
      {ios === null ? (
        <div className="gm-loading">
          <div className="gm-spinner" />
          <div>Loading IOs</div>
        </div>
      ) : noIos ? (
        <div className="gm-card-empty">
          <div className="gm-card-title">No IOs to test for this device</div>
          <div className="gm-card-body">
            <strong style={{ color: 'var(--gm-text)' }}>{device.deviceName}</strong> is
            on the SCADA layout but has no IO points in the local DB.
            <br /><br />
            This is normal for photoeyes (TPE), beacons (BCN), pushbuttons,
            and EPCs — their signals live as pin inputs on the parent FIOM
            module. Open the matching <code style={{
              fontFamily: 'var(--gm-mono)', fontSize: 11,
              background: 'rgba(255,255,255,0.06)', padding: '1px 5px',
              borderRadius: 3,
            }}>FIOM</code> for this row to find and test those pins.
          </div>
          <div className="gm-card-actions-row">
            <button className="gm-secondary" onClick={onClose}>Close</button>
            {nextDeviceName && (
              <button className="gm-cta" onClick={() => onNextDevice?.()} style={{ flex: 1 }}>
                Next · {nextDeviceName} <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      ) : allDone ? (
        <div className="gm-card-done">
          <div className="gm-card-title">
            <Check size={18} style={{ display: 'inline', verticalAlign: '-3px', marginRight: 6 }} />
            Device complete
          </div>
          <div className="gm-card-body">
            All {counts.total} IOs accounted for ({counts.passed} passed, {counts.failed} failed).
            <br />
            <span style={{ fontSize: 11, color: 'var(--gm-text-dim)' }}>
              Hit the ↺ button on any IO below to clear it and re-test.
            </span>
          </div>
          {currentTarget && currentTarget.deviceName !== device.deviceName && (
            <button className="gm-cta" onClick={onSelectCurrent}>
              Next: {currentTarget.deviceName} <ArrowRight size={14} />
            </button>
          )}
          <div className="gm-card-actions-row">
            <button
              className="gm-secondary"
              onClick={async () => {
                // Persist a reset for every IO on this device so the user can re-walk it.
                const list = ios ?? []
                for (const io of list) {
                  const r = effectiveResult(io)
                  if (r === 'Passed' || r === 'Failed') {
                    // Sequential rather than Promise.all so a 4xx on one IO doesn't
                    // leave the rest in a half-rolled state.
                    // eslint-disable-next-line no-await-in-loop
                    await clearResult(io.id)
                  }
                }
              }}
              title="Reset all results on this device back to untested (persists to DB)"
            >
              <RotateCcw size={12} /> Clear all results
            </button>
            <button
              className="gm-secondary"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      ) : currentIo ? (
        <>
          {/* Hero IO card — clickable to pan/zoom map to this device.
              key={currentIo.id} forces React to unmount the old card
              and mount a fresh one each time the user advances to the
              next IO, which replays the .gm-hero rise animation so
              the swap reads as the new IO sliding up into place. */}
          <button
            key={currentIo.id}
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

          {/* Per-IO actions are hidden in roadmap mode: the directive at top owns Pass/Fail/Skip */}
          {!roadmapActive && (
            <>
              <div className="gm-actions">
                <button
                  className="gm-action gm-action-pass"
                  onClick={() => markResult(currentIo.id, 'Passed')}
                  disabled={pendingIoId === currentIo.id}
                >
                  <Check size={18} /> {pendingIoId === currentIo.id ? 'Saving…' : 'Pass'}
                </button>
                <button
                  className="gm-action gm-action-fail"
                  onClick={() => markResult(currentIo.id, 'Failed')}
                  disabled={pendingIoId === currentIo.id}
                >
                  <X size={18} /> {pendingIoId === currentIo.id ? 'Saving…' : 'Fail'}
                </button>
              </div>

              {persistError && (
                <div className="gm-persist-error" role="alert">
                  Could not save: {persistError}
                </div>
              )}

              {/* Fire output — only shown for IOs that pattern-match as outputs
                  (DO / AO / :O. / :SO.). In demo mode this is a visual fire
                  (panel flashes the IO blue); Phase 2 hooks this to a real
                  PLC tag write. */}
              {isOutputIo(currentIo.name) && (
                <div className="gm-actions gm-actions--single">
                  <button
                    className="gm-action gm-action-fire"
                    onClick={() => {
                      setFlashIoId(currentIo.id)
                      window.setTimeout(() => setFlashIoId(p => (p === currentIo.id ? null : p)), 700)
                    }}
                    title="Fire this output (demo: visual flash only — real PLC write is Phase 2)"
                  >
                    <Power size={17} /> Fire output
                  </button>
                </div>
              )}

              <div className="gm-secondary-row">
                <button
                  className="gm-secondary"
                  data-variant="amber"
                  onClick={() => simulateSwap(currentIo, ios, setSwap)}
                  title="Inject a fake wrong-IO trigger to preview swap-detection UI"
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
          )}
        </>
      ) : null}

      {/* IO list — always visible when IOs exist so per-IO clear (↺) stays
          reachable even after the device hits 'Device complete'. */}
      {ios !== null && ios.length > 0 && (
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
                  {(r === 'Passed' || r === 'Failed') && (
                    <button
                      type="button"
                      className="gm-io-clear"
                      onClick={(e) => { e.stopPropagation(); clearResult(io.id) }}
                      title="Clear this result (undo Pass/Fail)"
                      aria-label="Clear this result"
                    >
                      <RotateCcw size={11} />
                    </button>
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

/**
 * RoadmapStepDirective — the scripted "do this now" block that lives at the
 * very top of the panel while a roadmap is playing. Owns its own Pass/Fail/
 * Skip/End controls; the per-IO action row below is hidden during playback.
 */
function RoadmapStepDirective({
  step, currentIndex, totalSteps, device, counts, onCenterOnDevice,
  onPass, onFail, onSkip, onPrevious, onEnd, canGoPrevious,
}: {
  step: RoadmapStep
  currentIndex: number
  totalSteps: number
  device: Device
  counts: { total: number; passed: number; failed: number }
  onCenterOnDevice: (name: string) => void
  onPass: () => void
  onFail: () => void
  onSkip: () => void
  onPrevious: () => void
  onEnd: () => void
  canGoPrevious: boolean
}) {
  const counter = `${String(currentIndex + 1).padStart(2, '0')} / ${String(totalSteps).padStart(2, '0')}`
  return (
    <section className="gm-roadmap-step" aria-label={`Roadmap step ${currentIndex + 1} of ${totalSteps}`}>
      <div className="gm-roadmap-step-eyebrow">
        <span>Step {counter}</span>
        <span className="gm-roadmap-step-counter">Roadmap</span>
      </div>

      <p className="gm-roadmap-step-instruction">{step.instructionText}</p>

      {step.transitText && (
        <div className="gm-roadmap-step-transit">
          <ChevronRight size={13} />
          <span>{step.transitText}</span>
        </div>
      )}

      {/* Inline device chip + IO counts (replaces the hidden gm-panel-head) */}
      <div className="gm-roadmap-step-device-row">
        <button
          type="button"
          className="gm-roadmap-step-device"
          onClick={() => onCenterOnDevice(device.deviceName)}
          title="Show on map"
        >
          <span className="gm-roadmap-step-device-label">Device</span>
          <span className="gm-roadmap-step-device-name">{device.deviceName}</span>
          <MapPin size={11} />
        </button>
        <div className="gm-roadmap-step-iostats">
          <span><strong>{counts.total}</strong> IO{counts.total === 1 ? '' : 's'}</span>
          {counts.passed > 0 && <span data-state="passed"><strong>{counts.passed}</strong> ok</span>}
          {counts.failed > 0 && <span data-state="failed"><strong>{counts.failed}</strong> fail</span>}
        </div>
      </div>

      {step.kind === 'io' && step.ioName && (
        <div className="gm-roadmap-step-io">
          Targeting IO <code>{step.ioName}</code>
        </div>
      )}

      <div className="gm-roadmap-step-actions">
        <button className="gm-action gm-action-pass" onClick={onPass}>
          <Check size={18} /> Pass
        </button>
        <button className="gm-action gm-action-fail" onClick={onFail}>
          <X size={18} /> Fail
        </button>
      </div>

      <div className="gm-roadmap-step-secondary">
        <button
          type="button"
          onClick={onPrevious}
          disabled={!canGoPrevious}
          title="Undo and go back to the previous step"
        >
          <ChevronLeft size={12} /> Previous
        </button>
        <button type="button" onClick={onSkip}>
          <SkipForward size={11} /> Skip
        </button>
        <button type="button" data-variant="end" onClick={onEnd}>
          <LogOut size={11} /> End walkdown
        </button>
      </div>
    </section>
  )
}

/**
 * RoadmapCompleteCard — replaces the entire panel body when the operator
 * has worked through every step of the authored route.
 */
function RoadmapCompleteCard({
  total, passed, failed, skipped, onEnd,
}: {
  total: number; passed: number; failed: number; skipped: number; onEnd: () => void
}) {
  return (
    <section className="gm-roadmap-done">
      <div className="gm-roadmap-done-eyebrow">Walkdown complete</div>
      <div className="gm-roadmap-done-title">
        {total} of {total} steps closed out
      </div>

      <div className="gm-roadmap-done-summary">
        <span data-state="passed"><strong>{passed}</strong>passed</span>
        <span data-state="failed"><strong>{failed}</strong>failed</span>
        <span data-state="skipped"><strong>{skipped}</strong>skipped</span>
      </div>

      <div className="gm-roadmap-done-actions">
        <button className="gm-cta" onClick={onEnd}>
          Return to SCADA flow <ArrowRight size={14} />
        </button>
      </div>
    </section>
  )
}

/** Render the rightmost segment of a tag path so the hero is readable on tablet. */
function shortIoCode(name: string): string {
  const idx = name.lastIndexOf(':')
  return idx >= 0 ? name.slice(idx + 1) : name
}

/**
 * Cheap heuristic for output-vs-input IO based on the tag name. Patterns
 * seen in the local Ios table:
 *   - Outputs: name ends with `_DO`, `_AO`, contains `:O.`, `:SO.`,
 *     contains `_DO.` / `_AO.` mid-string (FIOM output pin paths).
 *   - Inputs (NOT output): `_DI`, `:I.`, `:SI.`, `_AI`.
 * Used to decide whether to surface the "Fire output" button.
 */
function isOutputIo(name: string): boolean {
  return /(?:_DO\b|_AO\b|_DO\.|_AO\.|:O\.|:SO\.|:AO\.)/i.test(name)
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
