import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useUser } from '@/lib/user-context'
import { usePlcWebSocket } from '@/lib/plc/websocket-client'
import type { IOUpdate } from '@/lib/plc/websocket-client'
import { GuidedTestingMap } from '@/components/guided/guided-testing-map'
import type { GuidedTestingMapHandle } from '@/components/guided/guided-testing-map'
import type { Device } from '@/lib/guided/types'
import { useTaskPool } from '@/lib/guided/task-pool/use-task-pool'
import type { Step, Task } from '@/lib/guided/task-pool/types'
import { TaskViewer } from './task-viewer'
import './guided-tasks.css'

/** Only the network-loop task has no data backing → completes via manual flag. */
const MANUAL_COMPLETE_TYPES = new Set<Task['type']>(['network_loop'])

type Popup = { kind: 'pass' | 'fail'; message: string } | null
type EstopVerdict = { autoVerdict: string; checkTagValue: boolean | null } | null

function initialsOf(name?: string | null): string {
  if (!name) return ''
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase()
  return parts.map((p) => p[0]).join('').toUpperCase()
}
function stamp(name?: string | null): string {
  const d = new Date()
  return `${initialsOf(name)} ${d.getMonth() + 1}/${d.getDate()}`.trim()
}

export function GuidedTaskRunner({ subsystemId }: { subsystemId: number }) {
  const navigate = useNavigate()
  const { currentUser } = useUser()
  const ws = usePlcWebSocket()
  const { pool, isLoading, error, refresh } = useTaskPool(subsystemId)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [stepIndex, setStepIndex] = useState(0)
  const [popup, setPopup] = useState<Popup>(null)
  const [skipOpen, setSkipOpen] = useState(false)
  const [skipReason, setSkipReason] = useState('')
  const [viewerOpen, setViewerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [estopVerdict, setEstopVerdict] = useState<EstopVerdict>(null)

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

  useEffect(() => {
    if (!subsystemId) return
    fetch(`/api/maps/subsystem/${subsystemId}`)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setSvgMarkup)
      .catch(() => setSvgMarkup(null))
    reloadDevices()
  }, [subsystemId, reloadDevices])

  // Steps are built server-side (full data per task type) → fetch on task change.
  useEffect(() => {
    if (!effectiveTask) {
      setSteps([])
      setStepIndex(0)
      return
    }
    let cancelled = false
    fetch(`/api/guided/tasks/steps?subsystemId=${subsystemId}&taskId=${encodeURIComponent(effectiveTask.id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (cancelled) return
        setSteps(d.steps ?? [])
        setStepIndex(0)
      })
      .catch(() => {
        if (!cancelled) {
          setSteps([])
          setStepIndex(0)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTask?.id, subsystemId])

  // ── advance / complete ───────────────────────────────────────────────
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

  // ── recording ──────────────────────────────────────────────────────────
  const resolvedRef = useRef(false)

  /** Record a pass/fail for the CURRENT step, routing to the right endpoint. */
  const persistResult = useCallback(
    async (result: 'Passed' | 'Failed', opts?: { failureMode?: string; value?: string; popupOnly?: boolean }) => {
      const step = currentStep
      if (!step) return
      const user = currentUser?.fullName
      try {
        if (step.estopCheckTag) {
          await fetch('/api/estop/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subsystemId,
              zoneName: step.estopZone,
              checkTag: step.estopCheckTag,
              result: result === 'Passed' ? 'pass' : 'fail',
              failureMode: result === 'Failed' ? opts?.failureMode ?? 'No Drop' : undefined,
              testedBy: user,
            }),
          })
        } else if (step.l2ColumnId && step.l2DeviceId) {
          // functional check cell
          await fetch('/api/l2/cell', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceId: step.l2DeviceId,
              columnId: step.l2ColumnId,
              value: opts?.value ?? (result === 'Passed' ? 'Pass' : 'Fail'),
              updatedBy: user,
            }),
          })
        } else if (step.ioId) {
          await fetch('/api/guided/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ioId: step.ioId,
              result,
              currentUser: user,
              failureMode: result === 'Failed' ? opts?.failureMode ?? 'No Response' : undefined,
            }),
          })
        }
      } catch {
        /* best-effort; UI still advances on acknowledgment */
      }
    },
    [currentStep, currentUser, subsystemId],
  )

  /** io_check / estop / functional pass-fail → show acknowledgment popup. */
  const recordWithPopup = useCallback(
    async (result: 'Passed' | 'Failed', failureMode?: string) => {
      if (resolvedRef.current) return
      resolvedRef.current = true
      await persistResult(result, { failureMode })
      setPopup({
        kind: result === 'Passed' ? 'pass' : 'fail',
        message: result === 'Passed' ? 'Device successfully checked' : 'Device failed, added to punchlist',
      })
    },
    [persistResult],
  )

  /** VFD column (write-l2-cells by name) → advance, no popup. */
  const recordVfdColumn = useCallback(
    async (value: string) => {
      const step = currentStep
      if (!step?.l2Column || !effectiveTask?.deviceName) return
      setBusy(true)
      try {
        await fetch('/api/vfd-commissioning/write-l2-cells', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceName: effectiveTask.deviceName,
            updatedBy: initialsOf(currentUser?.fullName) || currentUser?.fullName,
            cells: [{ columnName: step.l2Column, value }],
          }),
        }).catch(() => {})
        setInputValue('')
        advanceStep()
      } finally {
        setBusy(false)
      }
    },
    [currentStep, effectiveTask, currentUser, advanceStep],
  )

  const recordVfdControls = useCallback(async () => {
    if (!effectiveTask?.deviceName) return
    setBusy(true)
    try {
      await fetch('/api/vfd-commissioning/controls-verified', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName: effectiveTask.deviceName, completedBy: initialsOf(currentUser?.fullName) }),
      }).catch(() => {})
      advanceStep()
    } finally {
      setBusy(false)
    }
  }, [effectiveTask, currentUser, advanceStep])

  /** Functional number/text cell → advance, no popup. */
  const recordFunctionalValue = useCallback(
    async (value: string) => {
      await persistResult('Passed', { value })
      setInputValue('')
      advanceStep()
    },
    [persistResult, advanceStep],
  )

  // ── live PLC watch (auto-detect) ─────────────────────────────────────────
  const baselineRef = useRef<Record<number, string | undefined>>({})
  const [liveState, setLiveState] = useState<string | null>(null)

  useEffect(() => {
    resolvedRef.current = false
    baselineRef.current = {}
    setLiveState(null)
    setInputValue(currentStep?.currentValue ?? '')
    const name = currentStep?.deviceName ?? effectiveTask?.deviceName
    if (name) {
      const t = setTimeout(() => mapRef.current?.centerOnDevice(name), 160)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id])

  // watch tag transitions for steps that carry watchIoIds (io_check + functional)
  useEffect(() => {
    const ids = currentStep?.watchIoIds
    if (!ids || ids.length === 0) return
    const watch = new Set(ids)
    const isAutoPassKind =
      currentStep?.kind === 'io_check' ||
      (currentStep?.kind === 'manual_confirm' && currentStep?.inputType === 'pass_fail')
    const cb = (u: IOUpdate) => {
      if (!watch.has(u.Id)) return
      if (u.State !== 'TRUE' && u.State !== 'FALSE') return
      setLiveState(u.State)
      const base = baselineRef.current[u.Id]
      if (base === undefined) {
        baselineRef.current[u.Id] = u.State
        return
      }
      if (u.State !== base && !resolvedRef.current && isAutoPassKind) {
        void recordWithPopup('Passed')
      }
    }
    ws.onIOUpdate(cb)
    return () => ws.offIOUpdate(cb)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id, recordWithPopup])

  // poll the e-stop auto-verdict for the current EPC step
  useEffect(() => {
    if (currentStep?.kind !== 'auto_detect' || !currentStep.estopCheckTag) return
    let active = true
    const tag = currentStep.estopCheckTag
    const poll = async () => {
      try {
        const res = await fetch('/api/estop/status')
        if (!res.ok || !active) return
        const data = await res.json()
        for (const z of data.zones ?? []) {
          for (const e of z.epcs ?? []) {
            if (e.checkTag === tag) {
              setEstopVerdict({ autoVerdict: e.autoVerdict, checkTagValue: e.checkTagValue })
              return
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    setEstopVerdict(null)
    void poll()
    const id = setInterval(poll, 2500)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [currentStep?.id])

  // ── skip ─────────────────────────────────────────────────────────────────
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
  const lockedDevices = useMemo(() => (focusName ? new Set<string>([focusName]) : null), [focusName])

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
      <header className="gt-header">
        <button className="gt-btn gt-btn-ghost gt-back" onClick={() => navigate(`/commissioning/${subsystemId}`)}>
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
          <div className="gt-progress" title={`${overallPct}% handled`}>
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

      <div className="gt-body">
        <div className="gt-map-layer">
          {svgMarkup ? (
            <GuidedTestingMap
              ref={mapRef}
              svgMarkup={svgMarkup}
              devices={devices}
              activeDevice={activeDevice}
              onDeviceClick={(name) => {
                const t = pool?.tasks.find(
                  (x) => x.deviceName === name && (x.state === 'available' || x.state === 'in_progress'),
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

        {effectiveTask && currentStep && (
          <div className={`gt-hud gt-hud-${currentStep.kind}`}>
            <div className="gt-hud-step">{currentStep.title}</div>
            {currentStep.instruction && <p className="gt-hud-instruction">{currentStep.instruction}</p>}
            {renderStepBody({
              step: currentStep,
              isLast: stepIndex >= steps.length - 1,
              busy,
              liveState,
              estopVerdict,
              inputValue,
              setInputValue,
              subsystemId,
              onAdvance: advanceStep,
              onComplete: completeAndNext,
              recordWithPopup,
              recordVfdColumn,
              recordVfdControls,
              recordFunctionalValue,
              userName: currentUser?.fullName,
            })}
          </div>
        )}

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

        {effectiveTask && (
          <button className="gt-btn gt-skip" onClick={() => setSkipOpen(true)} disabled={busy}>
            SKIP TASK
          </button>
        )}
      </div>

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

// ── step body renderer ───────────────────────────────────────────────────

interface BodyProps {
  step: Step
  isLast: boolean
  busy: boolean
  liveState: string | null
  estopVerdict: EstopVerdict
  inputValue: string
  setInputValue: (v: string) => void
  subsystemId: number
  onAdvance: () => void
  onComplete: () => void
  recordWithPopup: (result: 'Passed' | 'Failed', failureMode?: string) => void
  recordVfdColumn: (value: string) => void
  recordVfdControls: () => void
  recordFunctionalValue: (value: string) => void
  userName?: string | null
}

function LiveSignal({ liveState }: { liveState: string | null }) {
  return (
    <div className="gt-livestate">
      <span
        className={`gt-dot ${liveState === 'TRUE' ? 'gt-dot-on' : liveState === 'FALSE' ? 'gt-dot-off' : 'gt-dot-unknown'}`}
      />
      <span>Live PLC signal: {liveState === 'TRUE' ? 'ON' : liveState === 'FALSE' ? 'OFF' : 'waiting…'}</span>
    </div>
  )
}

function renderStepBody(p: BodyProps) {
  const { step } = p

  // 1) Navigate
  if (step.kind === 'navigate') {
    return (
      <div className="gt-actions-center">
        <button className="gt-btn gt-btn-primary gt-btn-xl" onClick={p.onAdvance}>
          I'M THERE
        </button>
      </div>
    )
  }

  // 2) Device IO check (auto-pass on actuation; manual Pass; Nothing Happened)
  if (step.kind === 'io_check') {
    return (
      <>
        <LiveSignal liveState={p.liveState} />
        <div className="gt-actions-center">
          <button className="gt-btn gt-btn-pass gt-btn-lg" disabled={p.busy} onClick={() => p.recordWithPopup('Passed')}>
            PASS
          </button>
          <button className="gt-btn gt-btn-warn gt-btn-lg" disabled={p.busy} onClick={() => p.recordWithPopup('Failed', 'No Response')}>
            NOTHING HAPPENED
          </button>
        </div>
      </>
    )
  }

  // 3) E-stop EPC (live auto-verdict + record)
  if (step.kind === 'auto_detect') {
    const v = p.estopVerdict?.autoVerdict ?? 'unknown'
    const tone = v === 'pass' ? 'gt-verdict-pass' : v === 'fail' ? 'gt-verdict-fail' : v === 'ready' ? 'gt-verdict-ready' : 'gt-verdict-unknown'
    return (
      <>
        <div className={`gt-verdict ${tone}`}>
          Auto-verdict: <strong>{v.toUpperCase()}</strong>
        </div>
        <div className="gt-actions-center">
          <button className="gt-btn gt-btn-pass gt-btn-lg" disabled={p.busy} onClick={() => p.recordWithPopup('Passed')}>
            RECORD PASS
          </button>
          <button className="gt-btn gt-btn-warn gt-btn-lg" disabled={p.busy} onClick={() => p.recordWithPopup('Failed', 'No Drop')}>
            RECORD FAIL
          </button>
        </div>
      </>
    )
  }

  // 4) manual_confirm variants
  if (step.vfdControls) {
    return (
      <div className="gt-actions-center">
        <button className="gt-btn gt-btn-primary gt-btn-lg" disabled={p.busy} onClick={p.recordVfdControls}>
          CONFIRM CONTROLS VERIFIED
        </button>
      </div>
    )
  }

  // VFD or functional data-entry column
  if (step.l2Column) {
    const isFunctional = !!step.l2ColumnId
    if (step.inputType === 'number' || step.inputType === 'text') {
      return (
        <div className="gt-actions-center gt-actions-stack">
          {step.watchIoIds && step.watchIoIds.length > 0 && <LiveSignal liveState={p.liveState} />}
          <input
            className="gt-input"
            type={step.inputType === 'number' ? 'number' : 'text'}
            value={p.inputValue}
            placeholder={step.inputType === 'number' ? 'Enter value' : 'Enter value'}
            onChange={(e) => p.setInputValue(e.target.value)}
          />
          <button
            className="gt-btn gt-btn-primary gt-btn-lg"
            disabled={p.busy || !p.inputValue.trim()}
            onClick={() =>
              isFunctional ? p.recordFunctionalValue(p.inputValue.trim()) : p.recordVfdColumn(p.inputValue.trim())
            }
          >
            SAVE & CONTINUE
          </button>
        </div>
      )
    }
    // pass_fail
    return (
      <>
        {step.watchIoIds && step.watchIoIds.length > 0 && <LiveSignal liveState={p.liveState} />}
        <div className="gt-actions-center">
          <button
            className="gt-btn gt-btn-pass gt-btn-lg"
            disabled={p.busy}
            onClick={() =>
              isFunctional ? p.recordWithPopup('Passed') : p.recordVfdColumn(stamp(p.userName))
            }
          >
            PASS
          </button>
          <button
            className="gt-btn gt-btn-warn gt-btn-lg"
            disabled={p.busy}
            onClick={() => (isFunctional ? p.recordWithPopup('Failed') : p.recordVfdColumn('Fail'))}
          >
            FAIL
          </button>
        </div>
      </>
    )
  }

  // plain manual_confirm / info (network loop, e-stop reset, etc.)
  return (
    <div className="gt-actions-center gt-actions-stack">
      <Link className="gt-link" to={`/commissioning/${p.subsystemId}`}>
        Open full commissioning view ↗
      </Link>
      {p.isLast ? (
        <button className="gt-btn gt-btn-primary gt-btn-lg" disabled={p.busy} onClick={p.onComplete}>
          MARK TASK DONE
        </button>
      ) : (
        <button className="gt-btn gt-btn-primary gt-btn-lg" disabled={p.busy} onClick={p.onAdvance}>
          CONTINUE
        </button>
      )}
    </div>
  )
}
