import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useUser } from '@/lib/user-context'
import { usePlcWebSocket } from '@/lib/plc/websocket-client'
import type { IOUpdate } from '@/lib/plc/websocket-client'
import { GuidedTestingMap } from '@/components/guided/guided-testing-map'
import type { GuidedTestingMapHandle } from '@/components/guided/guided-testing-map'
import type { Device } from '@/lib/guided/types'
import { useTaskPool } from '@/lib/guided/task-pool/use-task-pool'
import { buildSteps } from '@/lib/guided/task-pool/steps'
import type { StepIo } from '@/lib/guided/task-pool/steps'
import type { Step, Task } from '@/lib/guided/task-pool/types'
import { TaskViewer } from './task-viewer'
import './guided-tasks.css'

/** Task types whose detailed entry lives in a specialized view → manual "done". */
const MANUAL_COMPLETE_TYPES = new Set<Task['type']>([
  'network_loop',
  'vfd_setup',
  'functional_check',
  'estop_verification',
])

type Popup = { kind: 'pass' | 'fail'; message: string } | null

/**
 * Guided Mode — Task-Pool flow rendered ON the live SCADA SVG map.
 *
 * The existing subsystem SVG is the persistent backdrop; the current task's
 * device is focused (others dimmed) and the map auto-centers on it. Step
 * instructions + actions float as overlay cards (the Guided Mode spec
 * mockups). The main commissioning tool stays reachable via "Exit" and the
 * classic device-walk guided view via "Classic view" — nothing is replaced.
 */
export function GuidedTaskRunner({ subsystemId }: { subsystemId: number }) {
  const navigate = useNavigate()
  const { currentUser } = useUser()
  const ws = usePlcWebSocket()
  const { pool, isLoading, error, refresh } = useTaskPool(subsystemId)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [stepIndex, setStepIndex] = useState(0)
  const [, setDeviceIos] = useState<StepIo[]>([])
  const [popup, setPopup] = useState<Popup>(null)
  const [skipOpen, setSkipOpen] = useState(false)
  const [skipReason, setSkipReason] = useState('')
  const [viewerOpen, setViewerOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // SVG + device list for the map backdrop.
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const mapRef = useRef<GuidedTestingMapHandle | null>(null)

  const effectiveTask: Task | null = useMemo(() => {
    if (!pool) return null
    if (selectedTaskId) {
      const t = pool.tasks.find((x) => x.id === selectedTaskId)
      if (t && (t.state === 'available' || t.state === 'in_progress')) return t
    }
    return pool.tasks.find((t) => t.id === pool.nextTaskId) ?? null
  }, [pool, selectedTaskId])

  const currentStep: Step | null = steps[stepIndex] ?? null

  const reloadDevices = useCallback(() => {
    fetch(`/api/guided/devices?subsystemId=${subsystemId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setDevices(d.devices ?? []))
      .catch(() => {})
  }, [subsystemId])

  // ── load map assets once ───────────────────────────────────────────────
  useEffect(() => {
    if (!subsystemId) return
    fetch(`/api/maps/subsystem/${subsystemId}`)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setSvgMarkup)
      .catch(() => setSvgMarkup(null))
    reloadDevices()
  }, [subsystemId, reloadDevices])

  // ── build steps when the task changes ──────────────────────────────────
  useEffect(() => {
    if (!effectiveTask) {
      setSteps([])
      setStepIndex(0)
      return
    }
    let cancelled = false
    const isIoCheck =
      effectiveTask.type === 'io_check_safety' || effectiveTask.type === 'io_check_nonsafety'
    if (isIoCheck && effectiveTask.deviceName) {
      fetch(`/api/guided/devices/${encodeURIComponent(effectiveTask.deviceName)}?subsystemId=${subsystemId}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          if (cancelled) return
          const ios: StepIo[] = (d.ios ?? []).map((io: StepIo) => ({
            id: io.id,
            name: io.name,
            description: io.description,
            result: io.result,
          }))
          setDeviceIos(ios)
          setSteps(buildSteps(effectiveTask, ios))
          setStepIndex(0)
        })
        .catch(() => {
          if (cancelled) return
          setDeviceIos([])
          setSteps(buildSteps(effectiveTask, []))
          setStepIndex(0)
        })
    } else {
      setDeviceIos([])
      setSteps(buildSteps(effectiveTask))
      setStepIndex(0)
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTask?.id, subsystemId])

  // ── advance helpers ────────────────────────────────────────────────────
  const completeAndNext = useCallback(async () => {
    setBusy(true)
    try {
      if (effectiveTask && MANUAL_COMPLETE_TYPES.has(effectiveTask.type)) {
        await fetch('/api/guided/tasks/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subsystemId, taskId: effectiveTask.id, currentUser: currentUser?.fullName }),
        }).catch(() => {})
      }
      setSelectedTaskId(null)
      setStepIndex(0)
      await refresh()
      reloadDevices()
    } finally {
      setBusy(false)
    }
  }, [effectiveTask, subsystemId, currentUser, refresh, reloadDevices])

  const advanceStep = useCallback(() => {
    if (stepIndex < steps.length - 1) setStepIndex(stepIndex + 1)
    else void completeAndNext()
  }, [stepIndex, steps.length, completeAndNext])

  // ── io-check auto-detection ────────────────────────────────────────────
  const resolvedRef = useRef(false)
  const baselineRef = useRef<string | undefined>(undefined)
  const [liveState, setLiveState] = useState<string | null>(null)

  const recordIo = useCallback(
    async (result: 'Passed' | 'Failed', failureMode?: string) => {
      if (resolvedRef.current || !currentStep?.ioId) return
      resolvedRef.current = true
      try {
        await fetch('/api/guided/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ioId: currentStep.ioId,
            result,
            currentUser: currentUser?.fullName,
            failureMode: result === 'Failed' ? failureMode ?? 'No Response' : undefined,
          }),
        })
      } catch {
        /* best-effort; popup still lets the tester acknowledge */
      }
      setPopup({
        kind: result === 'Passed' ? 'pass' : 'fail',
        message: result === 'Passed' ? 'Device successfully checked' : 'Device failed, added to punchlist',
      })
    },
    [currentStep, currentUser],
  )

  // reset detection + center map on the step's device
  useEffect(() => {
    resolvedRef.current = false
    baselineRef.current = undefined
    setLiveState(null)
    const name = currentStep?.deviceName ?? effectiveTask?.deviceName
    if (name) {
      const t = setTimeout(() => mapRef.current?.centerOnDevice(name), 160)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id])

  // live tag transitions for the current io_check step
  useEffect(() => {
    if (!currentStep || currentStep.kind !== 'io_check' || !currentStep.ioId) return
    const ioId = currentStep.ioId
    const cb = (u: IOUpdate) => {
      if (u.Id !== ioId) return
      if (u.State !== 'TRUE' && u.State !== 'FALSE') return
      setLiveState(u.State)
      if (baselineRef.current === undefined) {
        baselineRef.current = u.State
        return
      }
      if (u.State !== baselineRef.current && !resolvedRef.current) void recordIo('Passed')
    }
    ws.onIOUpdate(cb)
    return () => ws.offIOUpdate(cb)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id, recordIo])

  // ── skip / unskip ──────────────────────────────────────────────────────
  const submitSkip = useCallback(async () => {
    const reason = skipReason.trim()
    if (!effectiveTask || !reason) return
    setBusy(true)
    try {
      await fetch('/api/guided/tasks/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subsystemId, taskId: effectiveTask.id, reason, currentUser: currentUser?.fullName }),
      })
      setSkipOpen(false)
      setSkipReason('')
      setSelectedTaskId(null)
      setStepIndex(0)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [skipReason, effectiveTask, subsystemId, currentUser, refresh])

  const unskip = useCallback(
    async (task: Task) => {
      await fetch('/api/guided/tasks/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subsystemId, taskId: task.id, unskip: true }),
      })
      await refresh()
    },
    [subsystemId, refresh],
  )

  const focusName = currentStep?.deviceName ?? effectiveTask?.deviceName ?? null
  const activeDevice = useMemo(
    () => (focusName ? devices.find((d) => d.deviceName === focusName) ?? null : null),
    [focusName, devices],
  )
  // Focus the current device: lock (dim) everything else.
  const lockedDevices = useMemo(
    () => (focusName ? new Set<string>([focusName]) : null),
    [focusName],
  )

  // ── render ───────────────────────────────────────────────────────────────
  if (isLoading) return <div className="gt-root gt-center">Loading guided tasks…</div>
  if (error) {
    return (
      <div className="gt-root gt-center">
        <div className="gt-empty">
          <p>{error}</p>
          <button className="gt-btn" onClick={() => navigate(`/commissioning/${subsystemId}`)}>
            Back to commissioning
          </button>
        </div>
      </div>
    )
  }

  const s = pool?.summary
  const overallPct = s && s.total > 0 ? Math.round(((s.completed + s.skipped) / s.total) * 100) : 0

  return (
    <div className="gt-root">
      {/* Header / context */}
      <header className="gt-header">
        <button
          className="gt-btn gt-btn-ghost gt-back"
          onClick={() => navigate(`/commissioning/${subsystemId}`)}
        >
          ← Exit
        </button>
        <div className="gt-context">
          <div className="gt-context-title">GUIDED MODE</div>
          {effectiveTask ? (
            <div className="gt-context-lines">
              <span>Phase: {effectiveTask.phase}</span>
              <span>Segment: {effectiveTask.segment}</span>
              <span>Task: {effectiveTask.title}</span>
            </div>
          ) : (
            <div className="gt-context-lines">
              <span>No task in progress</span>
            </div>
          )}
        </div>
        <div className="gt-header-right">
          <div className="gt-progress" title={`${overallPct}% of tasks handled`}>
            <div className="gt-progress-bar">
              <div className="gt-progress-fill" style={{ width: `${overallPct}%` }} />
            </div>
            <span className="gt-progress-label">{s ? `${s.completed}/${s.total} done` : ''}</span>
          </div>
          <Link className="gt-btn gt-btn-ghost gt-chip" to={`/commissioning/${subsystemId}/guided?classic=1`}>
            Classic view
          </Link>
          <button className="gt-btn gt-btn-ghost gt-chip" onClick={() => setViewerOpen(true)}>
            Task Viewer
          </button>
        </div>
      </header>

      {/* Body: live SVG map backdrop + floating step HUD */}
      <div className="gt-body">
        <div className="gt-map-layer">
          {svgMarkup ? (
            <GuidedTestingMap
              ref={mapRef}
              svgMarkup={svgMarkup}
              devices={devices}
              activeDevice={activeDevice}
              onDeviceClick={(name) => {
                // Jump to that device's IO-check task if it's workable.
                const t = pool?.tasks.find(
                  (x) =>
                    x.deviceName === name &&
                    (x.state === 'available' || x.state === 'in_progress'),
                )
                if (t) {
                  setSelectedTaskId(t.id)
                  setStepIndex(0)
                }
              }}
              lockedDevices={lockedDevices}
            />
          ) : (
            <div className="gt-map-fallback">&lt;map unavailable&gt;</div>
          )}
        </div>

        {/* Floating step HUD */}
        {effectiveTask && currentStep && (
          <div className={`gt-hud gt-hud-${currentStep.kind}`}>
            <div className="gt-hud-step">{currentStep.title}</div>
            {currentStep.instruction && <p className="gt-hud-instruction">{currentStep.instruction}</p>}

            {currentStep.kind === 'navigate' && (
              <div className="gt-actions-center">
                <button className="gt-btn gt-btn-primary gt-btn-xl" onClick={advanceStep}>
                  I'M THERE
                </button>
              </div>
            )}

            {currentStep.kind === 'io_check' && (
              <>
                <div className="gt-livestate">
                  <span
                    className={`gt-dot ${liveState === 'TRUE' ? 'gt-dot-on' : liveState === 'FALSE' ? 'gt-dot-off' : 'gt-dot-unknown'}`}
                  />
                  <span>
                    Live PLC signal: {liveState === 'TRUE' ? 'ON' : liveState === 'FALSE' ? 'OFF' : 'waiting…'}
                  </span>
                </div>
                <p className="gt-hint">If you checked the IO and nothing happened, click below:</p>
                <div className="gt-actions-center">
                  <button className="gt-btn gt-btn-warn gt-btn-lg" disabled={busy} onClick={() => recordIo('Failed', 'No Response')}>
                    NOTHING HAPPENED
                  </button>
                </div>
              </>
            )}

            {(currentStep.kind === 'manual_confirm' ||
              currentStep.kind === 'auto_detect' ||
              currentStep.kind === 'info') && (
              <div className="gt-actions-center gt-actions-stack">
                <Link className="gt-link" to={`/commissioning/${subsystemId}`}>
                  Open full commissioning view ↗
                </Link>
                {stepIndex >= steps.length - 1 ? (
                  <button className="gt-btn gt-btn-primary gt-btn-lg" disabled={busy} onClick={completeAndNext}>
                    MARK TASK DONE
                  </button>
                ) : (
                  <button className="gt-btn gt-btn-primary gt-btn-lg" disabled={busy} onClick={advanceStep}>
                    CONTINUE
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* All-done overlay */}
        {!effectiveTask && (
          <div className="gt-hud gt-hud-done">
            <div className="gt-empty-icon">✓</div>
            <div className="gt-hud-step">No tasks available right now</div>
            {s && (
              <p className="gt-hud-instruction">
                {s.completed} completed · {s.skipped} skipped
                {s.blocked > 0 ? ` · ${s.blocked} blocked by dependencies` : ''}
              </p>
            )}
            <div className="gt-actions-center">
              <button className="gt-btn gt-btn-ghost" onClick={() => navigate(`/commissioning/${subsystemId}`)}>
                Back to commissioning
              </button>
              <button className="gt-btn gt-btn-primary" onClick={() => setViewerOpen(true)}>
                Open Task Viewer
              </button>
            </div>
          </div>
        )}

        {/* Skip Task — pinned bottom-right (spec mockup) */}
        {effectiveTask && (
          <button className="gt-btn gt-skip" onClick={() => setSkipOpen(true)} disabled={busy}>
            SKIP TASK
          </button>
        )}
      </div>

      {/* Pass/Fail acknowledgment popup */}
      {popup && (
        <div className="gt-popup-overlay" role="alertdialog">
          <div className={`gt-popup gt-popup-${popup.kind}`}>
            <div className="gt-popup-icon">{popup.kind === 'pass' ? '✓' : '✕'}</div>
            <p className="gt-popup-msg">{popup.message}</p>
            <button
              className="gt-btn gt-btn-primary"
              autoFocus
              onClick={() => {
                setPopup(null)
                advanceStep()
              }}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Skip dialog — reason required */}
      {skipOpen && (
        <div className="gt-popup-overlay" role="dialog" aria-label="Skip task">
          <div className="gt-popup gt-skip-dialog">
            <h3>Skip this task?</h3>
            <p className="gt-popup-msg">{effectiveTask?.title}</p>
            <label className="gt-field-label" htmlFor="gt-skip-reason">
              Reason (required)
            </label>
            <textarea
              id="gt-skip-reason"
              className="gt-textarea"
              rows={3}
              value={skipReason}
              onChange={(e) => setSkipReason(e.target.value)}
              placeholder="Why are you skipping this task?"
              autoFocus
            />
            <div className="gt-dialog-actions">
              <button className="gt-btn gt-btn-ghost" onClick={() => setSkipOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="gt-btn gt-btn-warn" onClick={submitSkip} disabled={busy || !skipReason.trim()}>
                Skip Task
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Viewer */}
      {viewerOpen && pool && (
        <TaskViewer
          pool={pool}
          onClose={() => setViewerOpen(false)}
          onPick={(t) => {
            setSelectedTaskId(t.id)
            setStepIndex(0)
            setViewerOpen(false)
          }}
          onUnskip={(t) => void unskip(t)}
        />
      )}
    </div>
  )
}
