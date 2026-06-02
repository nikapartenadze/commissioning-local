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

export function GuidedTaskRunner({ subsystemId }: { subsystemId: number }) {
  const navigate = useNavigate()
  const { currentUser } = useUser()
  const ws = usePlcWebSocket()
  const { pool, isLoading, error, refresh } = useTaskPool(subsystemId)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [stepIndex, setStepIndex] = useState(0)
  const [deviceIos, setDeviceIos] = useState<StepIo[]>([])
  const [popup, setPopup] = useState<Popup>(null)
  const [skipOpen, setSkipOpen] = useState(false)
  const [skipReason, setSkipReason] = useState('')
  const [viewerOpen, setViewerOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // SVG + device list for the mini-map.
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const mapRef = useRef<GuidedTestingMapHandle | null>(null)

  // The effective task: a manual pick, else the pool's recommendation.
  const effectiveTask: Task | null = useMemo(() => {
    if (!pool) return null
    if (selectedTaskId) {
      const t = pool.tasks.find((x) => x.id === selectedTaskId)
      if (t && (t.state === 'available' || t.state === 'in_progress')) return t
    }
    return pool.tasks.find((t) => t.id === pool.nextTaskId) ?? null
  }, [pool, selectedTaskId])

  const currentStep: Step | null = steps[stepIndex] ?? null

  // ── load mini-map assets once ──────────────────────────────────────────
  useEffect(() => {
    if (!subsystemId) return
    fetch(`/api/maps/subsystem/${subsystemId}`)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => setSvgMarkup(t))
      .catch(() => setSvgMarkup(null))
    fetch(`/api/guided/devices?subsystemId=${subsystemId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setDevices(d.devices ?? []))
      .catch(() => setDevices([]))
  }, [subsystemId])

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
      fetch(
        `/api/guided/devices/${encodeURIComponent(effectiveTask.deviceName)}?subsystemId=${subsystemId}`,
      )
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
      // refresh devices so the map recolors
      fetch(`/api/guided/devices?subsystemId=${subsystemId}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => setDevices(d.devices ?? []))
        .catch(() => {})
    } finally {
      setBusy(false)
    }
  }, [effectiveTask, subsystemId, currentUser, refresh])

  const advanceStep = useCallback(() => {
    if (stepIndex < steps.length - 1) {
      setStepIndex(stepIndex + 1)
    } else {
      void completeAndNext()
    }
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
        /* best-effort; popup still shown so the tester can acknowledge */
      }
      setPopup({
        kind: result === 'Passed' ? 'pass' : 'fail',
        message:
          result === 'Passed' ? 'Device successfully checked' : 'Device failed, added to punchlist',
      })
    },
    [currentStep, currentUser],
  )

  // reset resolved/baseline on step change + recenter map on navigate steps
  useEffect(() => {
    resolvedRef.current = false
    baselineRef.current = undefined
    setLiveState(null)
    if (currentStep?.deviceName && (currentStep.kind === 'navigate')) {
      // small delay so the map has mounted
      const t = setTimeout(() => mapRef.current?.centerOnDevice(currentStep.deviceName!), 120)
      return () => clearTimeout(t)
    }
  }, [currentStep?.id])

  // subscribe to live tag transitions for the current io_check step
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
      if (u.State !== baselineRef.current && !resolvedRef.current) {
        void recordIo('Passed')
      }
    }
    ws.onIOUpdate(cb)
    return () => ws.offIOUpdate(cb)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id, recordIo])

  // ── skip ───────────────────────────────────────────────────────────────
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

  const activeDevice = useMemo(() => {
    const name = currentStep?.deviceName ?? effectiveTask?.deviceName
    if (!name) return null
    return devices.find((d) => d.deviceName === name) ?? null
  }, [currentStep, effectiveTask, devices])

  // ── render ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return <div className="gt-root gt-center">Loading guided tasks…</div>
  }
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
  const overallPct =
    s && s.total > 0 ? Math.round(((s.completed + s.skipped) / s.total) * 100) : 0

  return (
    <div className="gt-root">
      {/* Header / context */}
      <header className="gt-header">
        <button
          className="gt-btn gt-btn-ghost gt-back"
          onClick={() => navigate(`/commissioning/${subsystemId}/guided`)}
          aria-label="Exit guided tasks"
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
          <div className="gt-progress" title={`${overallPct}% of tasks done/handled`}>
            <div className="gt-progress-bar">
              <div className="gt-progress-fill" style={{ width: `${overallPct}%` }} />
            </div>
            <span className="gt-progress-label">
              {s ? `${s.completed}/${s.total} done` : ''}
            </span>
          </div>
          <button className="gt-btn gt-btn-ghost" onClick={() => setViewerOpen(true)}>
            Task Viewer
          </button>
        </div>
      </header>

      {/* Body */}
      {!effectiveTask ? (
        <AllDoneScreen
          summary={s}
          onOpenViewer={() => setViewerOpen(true)}
          onBack={() => navigate(`/commissioning/${subsystemId}`)}
        />
      ) : !currentStep ? (
        <div className="gt-stage gt-center">Preparing steps…</div>
      ) : (
        <main className="gt-stage">
          <h1 className="gt-step-title">{currentStep.title}</h1>

          {/* navigate step: mini-map */}
          {currentStep.kind === 'navigate' && (
            <>
              <div className="gt-map-box">
                {svgMarkup ? (
                  <GuidedTestingMap
                    ref={mapRef}
                    svgMarkup={svgMarkup}
                    devices={devices}
                    activeDevice={activeDevice}
                    onDeviceClick={() => {}}
                  />
                ) : (
                  <div className="gt-map-fallback">&lt;minimap unavailable&gt;</div>
                )}
              </div>
              <p className="gt-instruction">{currentStep.instruction}</p>
              <div className="gt-actions-center">
                <button className="gt-btn gt-btn-primary gt-btn-xl" onClick={advanceStep}>
                  I'M THERE
                </button>
              </div>
            </>
          )}

          {/* io_check step: auto-detect + Nothing Happened */}
          {currentStep.kind === 'io_check' && (
            <div className="gt-iocheck">
              <p className="gt-instruction">{currentStep.instruction}</p>
              <div className="gt-livestate">
                <span className={`gt-dot ${liveState === 'TRUE' ? 'gt-dot-on' : liveState === 'FALSE' ? 'gt-dot-off' : 'gt-dot-unknown'}`} />
                <span>
                  Live PLC signal:{' '}
                  {liveState === 'TRUE' ? 'ON' : liveState === 'FALSE' ? 'OFF' : 'waiting…'}
                </span>
              </div>
              <p className="gt-hint">If you checked the IO and nothing happened, click below:</p>
              <div className="gt-actions-center">
                <button
                  className="gt-btn gt-btn-warn gt-btn-lg"
                  disabled={busy}
                  onClick={() => recordIo('Failed', 'No Response')}
                >
                  NOTHING HAPPENED
                </button>
              </div>
            </div>
          )}

          {/* manual_confirm + auto_detect + info */}
          {(currentStep.kind === 'manual_confirm' ||
            currentStep.kind === 'auto_detect' ||
            currentStep.kind === 'info') && (
            <ManualStep
              step={currentStep}
              subsystemId={subsystemId}
              isLastStep={stepIndex >= steps.length - 1}
              busy={busy}
              onContinue={advanceStep}
              onComplete={completeAndNext}
            />
          )}

          {/* Skip Task — always available (spec: bottom-right) */}
          <button
            className="gt-btn gt-btn-ghost gt-skip"
            onClick={() => setSkipOpen(true)}
            disabled={busy}
          >
            SKIP TASK
          </button>
        </main>
      )}

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
              <button
                className="gt-btn gt-btn-warn"
                onClick={submitSkip}
                disabled={busy || !skipReason.trim()}
              >
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

function ManualStep({
  step,
  subsystemId,
  isLastStep,
  busy,
  onContinue,
  onComplete,
}: {
  step: Step
  subsystemId: number
  isLastStep: boolean
  busy: boolean
  onContinue: () => void
  onComplete: () => void
}) {
  return (
    <div className="gt-manual">
      <p className="gt-instruction">{step.instruction}</p>
      {step.kind === 'auto_detect' && (
        <p className="gt-hint">
          Use the dedicated view for live verdicts, then mark this task done.
        </p>
      )}
      <div className="gt-actions-center gt-actions-stack">
        <Link className="gt-link" to={`/commissioning/${subsystemId}`}>
          Open full commissioning view ↗
        </Link>
        {isLastStep ? (
          <button className="gt-btn gt-btn-primary gt-btn-lg" disabled={busy} onClick={onComplete}>
            MARK TASK DONE
          </button>
        ) : (
          <button className="gt-btn gt-btn-primary gt-btn-lg" disabled={busy} onClick={onContinue}>
            CONTINUE
          </button>
        )}
      </div>
    </div>
  )
}

function AllDoneScreen({
  summary,
  onOpenViewer,
  onBack,
}: {
  summary: { total: number; completed: number; skipped: number; blocked: number } | undefined
  onOpenViewer: () => void
  onBack: () => void
}) {
  const blocked = summary?.blocked ?? 0
  return (
    <div className="gt-stage gt-center">
      <div className="gt-empty">
        <div className="gt-empty-icon">✓</div>
        <h2>No tasks available right now</h2>
        {summary && (
          <p>
            {summary.completed} completed · {summary.skipped} skipped
            {blocked > 0 ? ` · ${blocked} blocked by dependencies` : ''}
          </p>
        )}
        {blocked > 0 && (
          <p className="gt-hint">
            Blocked tasks open up automatically as their dependencies are satisfied.
          </p>
        )}
        <div className="gt-dialog-actions">
          <button className="gt-btn gt-btn-ghost" onClick={onBack}>
            Back to commissioning
          </button>
          <button className="gt-btn gt-btn-primary" onClick={onOpenViewer}>
            Open Task Viewer
          </button>
        </div>
      </div>
    </div>
  )
}
