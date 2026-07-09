import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, X, Activity, Zap, AlertTriangle, SkipForward, MapPin, ChevronRight, ChevronLeft, LogOut, RotateCcw, Power, History, MessageSquarePlus, Pencil } from 'lucide-react'
import type { Device, IoSummary } from '@/lib/guided/types'
import type { RoadmapStep } from '@/lib/guided/roadmap-types'
import { useUser } from '@/lib/user-context'
import { usePlcWebSocket, type IOUpdate } from '@/lib/plc/websocket-client'
import { FailCommentDialog } from '@/components/fail-comment-dialog'
import { TestHistoryDialog } from '@/components/test-history-dialog'
import { isOutputIo, isSafetyOutput } from '@/lib/io-classification'

type HistoryRecord = {
  id: number
  result: string | null
  state: string | null
  comments: string | null
  testedBy: string | null
  timestamp: string
}

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

  /** Devices currently flagged with a PLC connection fault. When the
   *  selected device is in this set, Pass/Fail are blocked and a banner
   *  explains why — matches the regular grid's faulted-row treatment. */
  faultedDevices?: Set<string>
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
  faultedDevices,
}: Props) {
  const { currentUser } = useUser()
  const [ios, setIos] = useState<IoSummary[] | null>(null)
  const [localResults, setLocalResults] = useState<Record<number, IoResult>>({})
  const [swap, setSwap] = useState<SwapEvent | null>(null)
  const [flashIoId, setFlashIoId] = useState<number | null>(null)
  const [pendingIoId, setPendingIoId] = useState<number | null>(null)
  const [persistError, setPersistError] = useState<string | null>(null)
  /** When set, the FailCommentDialog is shown and the user is choosing a
   *  failure mode + (optional) comment before the Fail is persisted. */
  const [failDialogIo, setFailDialogIo] = useState<IoSummary | null>(null)
  /** Pending Fire-output toggle (real PLC write). Locks the button while
   *  the request is in flight so a quick double-tap doesn't double-fire. */
  const [firingIoId, setFiringIoId] = useState<number | null>(null)
  /** Test-history dialog state — reuses the same component the regular grid
   *  uses, fetched on demand from /api/history/:ioId. */
  const [historyIo, setHistoryIo] = useState<IoSummary | null>(null)
  const [historyData, setHistoryData] = useState<HistoryRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  /** Inline-comment editor: which IO is being edited and what's typed.
   *  Mirrors the regular grid's editingCommentId / editingCommentValue. */
  const [editingCommentId, setEditingCommentId] = useState<number | null>(null)
  const [editingCommentValue, setEditingCommentValue] = useState('')
  /** "Departing ghost" — the IO that was the active hero before the user
   *  passed or failed it. Rendered as a separate, decorative card that
   *  slides up and out of the stage so the next IO can rise into the slot.
   *  Cleared after the depart animation finishes (560 ms). Carries the
   *  verdict so the leaving card tints green/red one last time. */
  const [departingIo, setDepartingIo] = useState<{ io: IoSummary; result: 'Passed' | 'Failed' } | null>(null)
  const prevCurrentIoRef = useRef<IoSummary | null>(null)

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
      else if (k === 'f' && currentIo) setFailDialogIo(currentIo)
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
  async function markResult(
    ioId: number,
    result: IoResult,
    opts?: { comments?: string; failureMode?: string },
  ) {
    if (result === null) { clearResult(ioId); return }
    // Faulted-device gate — mirrors the regular grid + /api/ios/[id]/test.
    // Block both Pass and Fail when the parent network device is reporting
    // ConnectionFaulted=TRUE, because we don't trust the signal in either
    // direction while the device is unreachable.
    if (device && faultedDevices?.has(device.deviceName)) {
      setPersistError(`Cannot test — ${device.deviceName} has a PLC connection fault. Fix the fault first.`)
      window.setTimeout(() => setPersistError(null), 4000)
      return
    }
    // Install-tracker status no longer gates Pass — techs often test devices
    // before the tracker is updated.
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
          comments: opts?.comments,
          failureMode: opts?.failureMode,
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

  /** Toggle a real PLC output. Mirrors the regular grid's Fire-output flow
   *  (POST /api/ios/:id/fire-output with action: 'toggle'). The PLC tag
   *  reader will broadcast the new state over WS so the dot updates on
   *  its own — we don't need to set tagStates manually. */
  async function fireOutput(io: IoSummary) {
    if (isSafetyOutput(io.name)) {
      setPersistError('Safety outputs cannot be fired from here — driven by the safety PLC.')
      window.setTimeout(() => setPersistError(null), 4000)
      return
    }
    setFiringIoId(io.id)
    setPersistError(null)
    setFlashIoId(io.id)
    window.setTimeout(() => setFlashIoId(p => (p === io.id ? null : p)), 700)
    try {
      const r = await fetch(`/api/ios/${io.id}/fire-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle' }),
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({})) as { error?: string }
        throw new Error(e.error ?? `HTTP ${r.status}`)
      }
    } catch (err) {
      console.error('[DeviceTestPanel] fireOutput failed:', err)
      setPersistError(err instanceof Error ? err.message : 'Failed to fire output')
      window.setTimeout(() => setPersistError(null), 4000)
    } finally {
      setFiringIoId(p => (p === io.id ? null : p))
    }
  }

  /** Open the test-history dialog for an IO. Fetches lazily from
   *  /api/history/:ioId — same endpoint the regular grid uses. */
  async function showHistory(io: IoSummary) {
    setHistoryIo(io)
    setHistoryData([])
    setHistoryLoading(true)
    try {
      const r = await fetch(`/api/history/${io.id}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const rows = await r.json()
      setHistoryData(Array.isArray(rows) ? rows : [])
    } catch (err) {
      console.error('[DeviceTestPanel] showHistory failed:', err)
      setHistoryData([])
    } finally {
      setHistoryLoading(false)
    }
  }

  /** Save an edited comment on an already-tested IO. Uses PUT /api/ios/:id
   *  (comment-only update — preserves Result/Timestamp). Same endpoint the
   *  regular grid uses via API_ENDPOINTS.ioComment. */
  async function saveComment(ioId: number, comment: string) {
    const trimmed = comment.trim()
    setIos(prev => prev?.map(i => i.id === ioId ? { ...i, comments: trimmed || null } : i) ?? prev)
    setEditingCommentId(null)
    setEditingCommentValue('')
    try {
      const r = await fetch(`/api/ios/${ioId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments: trimmed, currentUser: currentUser?.fullName }),
      })
      if (!r.ok) {
        const e = await r.json().catch(() => ({}))
        throw new Error(e.error ?? `HTTP ${r.status}`)
      }
      await reloadDeviceIos()
      onResultsChanged?.()
    } catch (err) {
      console.error('[DeviceTestPanel] saveComment failed:', err)
      setPersistError(err instanceof Error ? err.message : 'Failed to save comment')
      window.setTimeout(() => setPersistError(null), 4000)
      // Reconcile from server so the row doesn't show the bad optimistic value.
      await reloadDeviceIos()
    }
  }

  const currentIo = useMemo<IoSummary | null>(() => {
    if (!ios) return null
    return ios.find(io => effectiveResult(io) === null) ?? null
  }, [ios, localResults])

  /* Hero IO transition orchestrator.
   *
   * When the user passes/fails the current IO, `localResults` updates and
   * `currentIo` advances to the next untested IO. We detect that swap here
   * and stamp a "departing ghost" carrying the verdict of the IO that just
   * left. The ghost is rendered alongside the new hero by the JSX below and
   * animates out via CSS keyframes; we clear it after the animation budget
   * (560 ms) so the stage is clean before any subsequent swap.
   *
   * Gates:
   *  - Only animates forward progress (prev had Passed/Failed). Clearing a
   *    completed IO can move currentIo backward — we let that swap happen
   *    instantly so the operator's correction reads as immediate, not as
   *    another scripted reveal.
   *  - Device changes set ios=null, which clears prevCurrentIoRef. The
   *    first IO of a new device arrives without a ghost — the device-
   *    level UI is already changing, so a card-level transition would
   *    just add noise. */
  useEffect(() => {
    if (!ios) { prevCurrentIoRef.current = null; return }
    const prev = prevCurrentIoRef.current
    if (currentIo && prev && prev.id !== currentIo.id) {
      const prevVerdict =
        localResults[prev.id] !== undefined
          ? localResults[prev.id]
          : ios.find(i => i.id === prev.id)?.result ?? null
      if (prevVerdict === 'Passed' || prevVerdict === 'Failed') {
        setDepartingIo({ io: prev, result: prevVerdict })
        const t = window.setTimeout(() => {
          setDepartingIo(d => (d?.io.id === prev.id ? null : d))
        }, 560)
        prevCurrentIoRef.current = currentIo
        return () => window.clearTimeout(t)
      }
    }
    prevCurrentIoRef.current = currentIo
  }, [currentIo?.id, ios, localResults])

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

  /** Parent device has an active PLC connection fault. Same handling as
   *  the regular grid: block both Pass and Fail; explain why. */
  const deviceFaulted = !!(device && faultedDevices?.has(device.deviceName))
  const passBlockedReason = deviceFaulted
    ? `Cannot test — ${device?.deviceName} has a PLC connection fault. Fix the fault first.`
    : null

  /* Live PLC tag state, sourced from the WS broadcast that the tag reader
   * publishes (every state change + a TagSnapshot on connect). Mirrors the
   * regular grid's circle indicator at enhanced-io-data-grid.tsx:750-763.
   * Stored as a ref-backed map so callbacks don't re-bind on every render. */
  const ws = usePlcWebSocket()
  const [tagStates, setTagStates] = useState<Record<number, 'TRUE' | 'FALSE'>>({})
  useEffect(() => {
    const handler = (u: IOUpdate) => {
      if (u.State === 'TRUE' || u.State === 'FALSE') {
        setTagStates(prev => (prev[u.Id] === u.State ? prev : { ...prev, [u.Id]: u.State as 'TRUE' | 'FALSE' }))
      }
    }
    ws.onIOUpdate(handler)
    return () => { ws.offIOUpdate(handler) }
  }, [ws])

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
          {/* Hero IO card lives inside a positioned stage so the previous
              IO can render as a "departing ghost" stacked above the new one
              and slide up and out while the new card rises into the slot.
              key={currentIo.id} on the live button forces a remount on
              every swap, replaying the gm-hero-arrive animation. */}
          <div className="gm-hero-stage">
            {departingIo && (
              <div
                key={`depart-${departingIo.io.id}`}
                className="gm-hero gm-hero--departing"
                data-result={departingIo.result}
                aria-hidden="true"
              >
                <div className="gm-hero-eyebrow-row">
                  <span className="gm-hero-eyebrow" data-result={departingIo.result}>
                    {departingIo.result === 'Passed' ? 'Passed' : 'Failed'}
                  </span>
                  <span className="gm-hero-stamp" data-result={departingIo.result}>
                    {departingIo.result === 'Passed' ? <Check size={11} /> : <X size={11} />}
                    <span>{departingIo.result === 'Passed' ? 'OK' : 'NG'}</span>
                  </span>
                </div>
                <div className="gm-hero-name">{departingIo.io.name}</div>
                {departingIo.io.description && (
                  <div className="gm-hero-desc">{departingIo.io.description}</div>
                )}
                <div className="gm-signal gm-signal--quiet">
                  <span className="gm-signal-dot gm-signal-dot--quiet" />
                  <span className="gm-signal-text">
                    Logged — advancing to next IO
                  </span>
                </div>
              </div>
            )}
            <button
              key={currentIo.id}
              type="button"
              className="gm-hero gm-hero-btn gm-hero--arriving"
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
              {/* Scan-rail overlay — a one-shot orange light sweeps across
                  the arriving card to mark the new IO locking into place.
                  Animation is keyed off the .gm-hero--arriving mount so it
                  replays per swap, alongside the rise. */}
              <span className="gm-hero-scanrail" aria-hidden="true" />
            </button>
          </div>

          {/* Per-IO actions are hidden in roadmap mode: the directive at top owns Pass/Fail/Skip */}
          {!roadmapActive && (
            <>
              <div className="gm-actions">
                <button
                  className="gm-action gm-action-pass"
                  onClick={() => markResult(currentIo.id, 'Passed')}
                  disabled={pendingIoId === currentIo.id || deviceFaulted}
                  title={passBlockedReason ?? undefined}
                >
                  <Check size={18} /> {pendingIoId === currentIo.id ? 'Saving…' : 'Pass'}
                </button>
                <button
                  className="gm-action gm-action-fail"
                  onClick={() => setFailDialogIo(currentIo)}
                  disabled={pendingIoId === currentIo.id || deviceFaulted}
                  title={deviceFaulted ? passBlockedReason ?? undefined : undefined}
                >
                  <X size={18} /> {pendingIoId === currentIo.id ? 'Saving…' : 'Fail'}
                </button>
              </div>
              {passBlockedReason && (
                <div className="gm-persist-error" role="status" style={{ background: 'rgba(220, 38, 38, 0.08)', borderColor: 'rgba(220, 38, 38, 0.35)', color: 'var(--gm-red)' }}>
                  {passBlockedReason}
                </div>
              )}

              {persistError && (
                <div className="gm-persist-error" role="alert">
                  Could not save: {persistError}
                </div>
              )}

              {/* Fire output — only shown for IOs that pattern-match as outputs
                  (DO / AO / :O. / :SO.). Toggles the real PLC bit via the
                  same endpoint the regular grid uses. Safety outputs (:SO.)
                  are server-side rejected; we surface that as a banner. */}
              {isOutputIo(currentIo.name, currentIo.description) && (
                <div className="gm-actions gm-actions--single">
                  <button
                    className="gm-action gm-action-fire"
                    onClick={() => fireOutput(currentIo)}
                    disabled={firingIoId === currentIo.id || isSafetyOutput(currentIo.name) || deviceFaulted}
                    title={
                      isSafetyOutput(currentIo.name)
                        ? 'Safety outputs are driven by the safety PLC and cannot be fired from here'
                        : deviceFaulted
                          ? 'Device is faulted — fix the fault before firing outputs'
                          : 'Toggle this output on the PLC'
                    }
                  >
                    <Power size={17} /> {firingIoId === currentIo.id ? 'Firing…' : 'Fire output'}
                  </button>
                </div>
              )}

              {/* Dev-only: the swap detector is mocked. Hide in production so
                  field testers don't try to use a fake feature. Real wrong-
                  wiring detection arrives with Phase 2. */}
              {import.meta.env.DEV && (
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
              )}

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
              const isTested = r === 'Passed' || r === 'Failed'
              const isEditingComment = editingCommentId === io.id
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
                  <div className="gm-io-row">
                    <span className="gm-io-icon" data-state={state}>
                      <Icon size={state === 'pending' ? 12 : 14} />
                    </span>
                    <div className="gm-io-text">
                      <div className="gm-io-name">
                        <span
                          className="gm-io-statedot"
                          data-state={tagStates[io.id] ?? 'UNKNOWN'}
                          title={`PLC tag: ${tagStates[io.id] ?? 'no signal yet'}`}
                        />
                        {shortIoCode(io.name)}
                      </div>
                      {io.description && <div className="gm-io-desc">{io.description}</div>}
                    </div>
                    {io.installationPercent != null && (
                      <span
                        className="gm-io-install"
                        data-installed={io.installationPercent >= 1.0 ? 'true' : 'false'}
                        title={`Installation: ${Math.floor(io.installationPercent * 100)}%`}
                      >
                        {io.installationPercent >= 1.0
                          ? 'Installed'
                          : `${Math.floor(io.installationPercent * 100)}%`}
                      </span>
                    )}
                    {state !== 'pending' && (
                      <span className="gm-io-tag" data-state={state}>
                        {state === 'current' ? 'Active' : state}
                      </span>
                    )}
                    {isTested && (
                      <button
                        type="button"
                        className="gm-io-iconbtn"
                        onClick={(e) => { e.stopPropagation(); showHistory(io) }}
                        title="View test history"
                        aria-label="View test history"
                      >
                        <History size={12} />
                      </button>
                    )}
                    {isTested && (
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

                  {/* Comment line — shown when the IO has been tested.
                      Click to edit, Enter saves, Esc cancels. Uses the same
                      PUT /api/ios/:id path the regular grid uses. */}
                  {isTested && (
                    <div className="gm-io-comment">
                      {isEditingComment ? (
                        <input
                          type="text"
                          className="gm-io-comment-input"
                          autoFocus
                          value={editingCommentValue}
                          onChange={(e) => setEditingCommentValue(e.target.value)}
                          onBlur={() => saveComment(io.id, editingCommentValue)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              saveComment(io.id, editingCommentValue)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              setEditingCommentId(null)
                              setEditingCommentValue('')
                            }
                          }}
                          maxLength={500}
                          placeholder="Add a note…"
                        />
                      ) : io.comments ? (
                        <button
                          type="button"
                          className="gm-io-comment-text"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingCommentId(io.id)
                            setEditingCommentValue(io.comments ?? '')
                          }}
                          title="Click to edit"
                        >
                          <Pencil size={10} />
                          <span>{io.comments}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="gm-io-comment-add"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingCommentId(io.id)
                            setEditingCommentValue('')
                          }}
                          title="Add a note to this result"
                        >
                          <MessageSquarePlus size={11} />
                          <span>Add note</span>
                        </button>
                      )}
                    </div>
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
            markResult(currentIo.id, 'Failed', { failureMode: 'Wrong wiring' })
            markResult(swap.actualIoId, 'Passed')
            setSwap(null)
          }}
          onDismiss={() => setSwap(null)}
        />
      )}

      {/* Failure-mode dialog — same component the regular grid uses. Renders
       *  with the global app theme rather than the cockpit palette; a future
       *  pass can re-skin if the cockpit aesthetic needs to extend here. */}
      <FailCommentDialog
        open={failDialogIo !== null}
        onOpenChange={(open) => { if (!open) setFailDialogIo(null) }}
        io={failDialogIo ? { name: failDialogIo.name, description: failDialogIo.description } : null}
        onSubmit={(io, comment, failureMode) => {
          if (failDialogIo) {
            markResult(failDialogIo.id, 'Failed', { comments: comment, failureMode })
          }
          setFailDialogIo(null)
        }}
        onCancel={() => setFailDialogIo(null)}
      />

      {/* Test-history dialog — reuses the same component the regular grid
       *  mounts, so the UX is consistent across surfaces. While loading we
       *  pass an empty array; the dialog renders its own "no history" state
       *  for that brief window. */}
      <TestHistoryDialog
        open={historyIo !== null}
        onOpenChange={(open) => { if (!open) { setHistoryIo(null); setHistoryData([]) } }}
        ioName={historyIo?.name ?? ''}
        ioDescription={historyIo?.description ?? null}
        history={historyLoading ? [] : historyData}
      />
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
