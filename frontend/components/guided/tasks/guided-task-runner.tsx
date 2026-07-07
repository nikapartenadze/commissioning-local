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
import {
  advanceRoundTrip,
  sequenceHint,
  startRoundTrip,
  type RoundTrip,
} from '@/lib/guided/io-check-sequence'
import { SKIP_REASONS, composeSkipReason, type SkipReason } from '@/lib/guided/task-pool/skip-reasons'
import {
  createSwapWatch,
  spareHitComment,
  swapComment,
  type SwapCandidateIo,
  type SwapSuspicion,
  type SwapWatch,
} from '@/lib/guided/swap-watch'
import { saveL2Cell } from '@/lib/l2-outbox'
import { authFetch } from '@/lib/api-config'
import { TaskViewer } from './task-viewer'
import './guided-tasks.css'

/** Tasks with no data backing → complete via the manual GuidedTaskState flag.
 *  firmware_check belongs here too: recording its verdict writes nothing (the
 *  scan result lives on the firmware page), so without the flag the pool
 *  re-served the firmware task forever after the operator recorded it. */
const MANUAL_COMPLETE_TYPES = new Set<Task['type']>(['network_loop', 'firmware_check'])

type Popup = { kind: 'pass' | 'fail'; message: string } | null

/**
 * Value recorded when a tester skips a single functional/VFD column step
 * (e.g. the "(SCADA)" columns, which are verified separately). It is a
 * non-empty value, so it counts toward L2 completion (countCompleted in
 * /api/l2/cell) and the task can still close — without a Pass/Fail verdict.
 */
const SKIP_STEP_VALUE = 'N/A (skipped)'
type EstopVerdict = { autoVerdict: string; checkTagValue: boolean | null } | null

/** Live D4/D5 status polled from /api/guided/system-status. */
interface SystemStatus {
  ring: { state: string; reason?: string; lastActiveNode1?: string | null; lastActiveNode2?: string | null } | null
  systemRunning: boolean | null
}

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

  // usePlcWebSocket does NOT auto-connect — the caller owns the connect()
  // (same contract as the main commissioning page). Without this the runner
  // only ever got a socket when a visibilitychange fired (tab switch), so
  // live auto-pass/swap detection worked "sometimes" in the field and never
  // in a fresh kiosk tab.
  useEffect(() => {
    ws.connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [stepIndex, setStepIndex] = useState(0)
  const [popup, setPopup] = useState<Popup>(null)
  const [skipOpen, setSkipOpen] = useState(false)
  // D9: preset reason + optional note (free text only required for "Other").
  const [skipPreset, setSkipPreset] = useState<SkipReason | null>(null)
  const [skipNote, setSkipNote] = useState('')
  const [viewerOpen, setViewerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [estopVerdict, setEstopVerdict] = useState<EstopVerdict>(null)
  const [firmwareVerdict, setFirmwareVerdict] = useState<FirmwareVerdict>(null)
  // Live swap suspicion for the current io_check step (wrong-wiring banner).
  const [swap, setSwap] = useState<(SwapSuspicion & { comment: string }) | null>(null)
  const swapCandidatesRef = useRef<SwapCandidateIo[]>([])
  const swapWatchRef = useRef<SwapWatch | null>(null)
  // Readiness banner: warnings can be dismissed; hard blockers always show.
  const [readinessDismissed, setReadinessDismissed] = useState(false)
  // D4/D5 live gates — polled every 5 s while the runner is open.
  const [sysStatus, setSysStatus] = useState<SystemStatus>({ ring: null, systemRunning: null })

  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const mapRef = useRef<GuidedTestingMapHandle | null>(null)
  // Lightweight, auto-dismissing hint shown when a locked device is tapped.
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }, [])
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

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

  // D4/D5 live status poll — ring health gates the whole runner (committee:
  // "guided mode cannot function if DPM ring health is not nominal, and this
  // should be made extremely obvious"); system-running gates functional steps.
  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        // Scoped to THIS MCM — without the param a central/multi-MCM server
        // answers with the singleton ring (null) and the fleet-union D4, so
        // another MCM's running conveyors would unlock functional steps here.
        const r = await fetch(`/api/guided/system-status?subsystemId=${subsystemId}`)
        if (!r.ok || !active) return
        const data = (await r.json()) as SystemStatus
        if (active) setSysStatus(data)
      } catch {
        /* keep last status */
      }
    }
    void poll()
    const id = setInterval(poll, 5000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [subsystemId])

  const ringDegraded = sysStatus.ring?.state === 'degraded'

  // Swap-detection candidates: every still-untested IO of the subsystem.
  // Fetched once per io_check task (results recorded during the task only
  // shrink the honest set; a stale candidate at worst re-reports and the
  // operator dismisses). Non-io_check tasks never watch for swaps.
  useEffect(() => {
    swapCandidatesRef.current = []
    swapWatchRef.current = null
    if (!effectiveTask?.type.startsWith('io_check')) return
    let cancelled = false
    fetch(`/api/ios?subsystemId=${subsystemId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (cancelled) return
        swapCandidatesRef.current = (d.ios ?? [])
          // Untested INPUTS only: outputs are logic-driven, so an output
          // changing during a check is not a tester-actuation signature.
          .filter(
            (io: { result?: string | null; isOutput?: boolean }) =>
              (io.result == null || io.result === 'Not Tested') && !io.isOutput,
          )
          .map((io: { id: number; name: string; description?: string | null }) => ({
            id: io.id,
            name: io.name,
            description: io.description,
          }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTask?.id, subsystemId])

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
    async (result: 'Passed' | 'Failed', opts?: { failureMode?: string; value?: string; popupOnly?: boolean; comments?: string }) => {
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
              // Dual-safety: record against the step's check type (zone-stop vs
              // selectivity). Defaults server-side to 'preliminary' if omitted.
              checkType: step.estopCheckType ?? 'preliminary',
              result: result === 'Passed' ? 'pass' : 'fail',
              failureMode: result === 'Failed' ? opts?.failureMode ?? 'No Drop' : undefined,
              testedBy: user,
            }),
          })
        } else if (step.l2ColumnId && step.l2DeviceId) {
          // functional check cell — durable save (outbox + retry) so a guided
          // verdict is never silently lost if the POST fails or the tablet is
          // reloaded mid-step. Same path as the FV grid save.
          const r = await saveL2Cell(
            {
              deviceId: step.l2DeviceId,
              columnId: step.l2ColumnId,
              value: opts?.value ?? (result === 'Passed' ? 'Pass' : 'Fail'),
              updatedBy: user,
              ts: Date.now(),
            },
            {
              storage: typeof window !== 'undefined' ? window.localStorage : ({ getItem: () => null, setItem: () => {} } as any),
              fetchFn: (i, init) => authFetch(i, init) as any,
            },
          )
          if (!r.ok) console.error('[Guided] FV cell save not confirmed — queued in outbox for retry:', r)
        } else if (step.ioId) {
          await fetch('/api/guided/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ioId: step.ioId,
              result,
              currentUser: user,
              failureMode: result === 'Failed' ? opts?.failureMode ?? 'No Response' : undefined,
              comments: opts?.comments,
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
    async (result: 'Passed' | 'Failed', failureMode?: string, comments?: string) => {
      if (resolvedRef.current) return
      resolvedRef.current = true
      setSwap(null) // a recorded verdict supersedes any open swap suspicion
      await persistResult(result, { failureMode, comments })
      setPopup({
        kind: result === 'Passed' ? 'pass' : 'fail',
        message: result === 'Passed' ? 'Device successfully checked' : 'Device failed, added to punchlist',
      })
    },
    [persistResult],
  )

  /** Operator accepts the swap banner: the EXPECTED point fails with the
   *  wrong-wiring auto-comment (spec: auto-comment, user accepts the fail).
   *  If the triggered point is a SPARE, it is failed too — an unexpected live
   *  state on a SPARE is itself wrong wiring (spare semantics). The triggered
   *  point is otherwise left untested: its own check must still prove it. */
  const acceptSwap = useCallback(async () => {
    const s = swap
    if (!s || resolvedRef.current) return
    if (s.spare) {
      void fetch('/api/guided/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ioId: s.ioId,
          result: 'Failed',
          currentUser: currentUser?.fullName,
          failureMode: 'Wrong wiring',
          comments: spareHitComment(currentStep?.ioName ?? 'expected IO'),
        }),
      }).catch(() => {})
    }
    await recordWithPopup('Failed', 'Wrong wiring', s.comment)
  }, [swap, recordWithPopup, currentUser, currentStep?.ioName])

  const dismissSwap = useCallback(() => {
    if (swap) swapWatchRef.current?.rearm(swap.ioId)
    setSwap(null)
  }, [swap])

  /** VFD column (write-l2-cells by name) → advance, no popup. */
  const recordVfdColumn = useCallback(
    async (value: string) => {
      const step = currentStep
      if (!step?.l2Column || !effectiveTask?.deviceName) return
      setBusy(true)
      try {
        // Only advance if the cell ACTUALLY persisted. A missing column (e.g.
        // L2 schema not yet pulled) makes the server drop the write and return
        // success:false — previously we swallowed that and advanced anyway, so
        // the tester's value was silently lost (the CDW5 polarity class). Now
        // we surface it and keep the step so the value isn't lost.
        let ok = false
        try {
          const res = await fetch('/api/vfd-commissioning/write-l2-cells', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceName: effectiveTask.deviceName,
              updatedBy: initialsOf(currentUser?.fullName) || currentUser?.fullName,
              cells: [{ columnName: step.l2Column, value }],
            }),
          })
          const body = await res.json().catch(() => null)
          ok = res.ok && body?.success !== false
        } catch {
          ok = false
        }
        if (!ok) {
          showToast(`Couldn't save "${step.l2Column}" — not advancing. Pull the latest L2 data and retry.`)
          return
        }
        setInputValue('')
        advanceStep()
      } finally {
        setBusy(false)
      }
    },
    [currentStep, effectiveTask, currentUser, advanceStep, showToast],
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

  // ── live PLC watch (io_check round-trip — committee D6) ────────────────────
  // The check passes only on the FULL sequence: NC TRUE→FALSE→TRUE,
  // NO FALSE→TRUE→FALSE. Functional checks no longer watch anything (D1).
  const roundTripRef = useRef<RoundTrip>(startRoundTrip(null))
  const [liveState, setLiveState] = useState<string | null>(null)
  const [seqPhase, setSeqPhase] = useState<RoundTrip['phase']>('arming')

  useEffect(() => {
    resolvedRef.current = false
    roundTripRef.current = startRoundTrip(currentStep?.circuit ?? null)
    setSeqPhase(roundTripRef.current.phase)
    setLiveState(null)
    setSwap(null)
    swapWatchRef.current = null
    setInputValue(currentStep?.currentValue ?? '')
    const name = currentStep?.deviceName ?? effectiveTask?.deviceName
    if (name) {
      const t = setTimeout(() => mapRef.current?.centerOnDevice(name), 160)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id])

  // Watch tag transitions for io_check steps only (D1 removed the functional
  // auto-assist; D6 made the io_check verdict a full round trip).
  useEffect(() => {
    const ids = currentStep?.watchIoIds
    if (!ids || ids.length === 0 || currentStep?.kind !== 'io_check') return
    const watch = new Set(ids)
    const expectedLabel = currentStep?.ioName ?? 'the expected IO'
    const deviceName = currentStep?.deviceName ?? effectiveTask?.deviceName
    const cb = (u: IOUpdate) => {
      if (u.State !== 'TRUE' && u.State !== 'FALSE') return
      if (!watch.has(u.Id)) {
        // Unexpected point moved while we wait on the expected one — feed the
        // swap watcher. A candidate reports only on a FULL round-trip, so
        // background flaps and static reads never fire the banner.
        if (resolvedRef.current) return
        if (!swapWatchRef.current) {
          if (swapCandidatesRef.current.length === 0) return
          swapWatchRef.current = createSwapWatch(
            swapCandidatesRef.current.filter((c) => !watch.has(c.id)),
            deviceName,
          )
        }
        const hit = swapWatchRef.current.feed(u.Id, u.State)
        if (hit) {
          const cand = swapCandidatesRef.current.find((c) => c.id === hit.ioId)
          setSwap((prev) =>
            prev ?? {
              ...hit,
              comment: swapComment(expectedLabel, cand ?? { id: hit.ioId, name: hit.ioName }),
            },
          )
        }
        return
      }
      setLiveState(u.State)
      const next = advanceRoundTrip(roundTripRef.current, u.State)
      if (next !== roundTripRef.current) {
        roundTripRef.current = next
        setSeqPhase(next.phase)
      }
      if (next.phase === 'complete' && !resolvedRef.current) {
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
        // Scoped: identical PLC programs mean checkTag NAMES collide across
        // MCMs — the unscoped (all-zones) response could match another MCM's
        // EPC row and report ITS verdict here.
        const res = await fetch(`/api/estop/status?subsystemId=${subsystemId}`)
        if (!res.ok || !active) return
        const data = await res.json()
        // Dual-safety: show the verdict matching THIS step's check type. The
        // status route exposes both preliminaryVerdict (zone-stop) and
        // finalVerdict (selectivity); reading the dead `autoVerdict` left the
        // step stuck on "unknown" forever (pre-fix).
        const wantFinal = currentStep?.estopCheckType === 'final'
        for (const z of data.zones ?? []) {
          for (const e of z.epcs ?? []) {
            if (e.checkTag === tag) {
              setEstopVerdict({
                autoVerdict: wantFinal ? e.finalVerdict : e.preliminaryVerdict,
                checkTagValue: e.checkTagValue,
              })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id, subsystemId])

  // poll the firmware-compliance verdict for the firmware-check auto_detect step.
  // NEEDS LIVE VERIFICATION (battle sim / real MCM) before release — the polling,
  // scan trigger and task completion can't be exercised without a connected PLC.
  useEffect(() => {
    if (currentStep?.kind !== 'auto_detect' || currentStep.verdictSource !== '/api/firmware') return
    let active = true
    const poll = async () => {
      try {
        const res = await fetch('/api/firmware')
        if (!res.ok || !active) return
        const scan = (await res.json())?.scan
        if (!scan || !scan.connected) {
          setFirmwareVerdict({ verdict: 'unknown', nonCompliant: 0, deviceCount: 0, scanned: false })
          return
        }
        // Scope to this subsystem on a central server (devices carry subsystemId);
        // single-MCM devices carry none → all count.
        const devs = (scan.devices ?? []).filter(
          (d: { subsystemId?: string }) => d.subsystemId == null || String(d.subsystemId) === String(subsystemId),
        )
        const nonCompliant = devs.filter((d: { verdict?: string }) => d.verdict === 'non_compliant').length
        setFirmwareVerdict({ verdict: nonCompliant > 0 ? 'fail' : 'pass', nonCompliant, deviceCount: devs.length, scanned: true })
      } catch {
        /* ignore — next tick retries */
      }
    }
    setFirmwareVerdict(null)
    // Kick a fresh scan so the verdict is live, then poll the cached result.
    void fetch('/api/firmware/scan', { method: 'POST' }).catch(() => {}).then(() => poll())
    const id = setInterval(poll, 2500)
    return () => {
      active = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.id, subsystemId])

  // ── skip (D9: preset reason + optional note) ───────────────────────────────
  const skipReasonValid = skipPreset != null && (skipPreset !== 'Other' || skipNote.trim().length > 0)
  const submitSkip = useCallback(async () => {
    if (!effectiveTask || !skipPreset) return
    const reason = composeSkipReason(skipPreset, skipNote)
    if (!reason) return
    setBusy(true)
    try {
      await fetch('/api/guided/tasks/skip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subsystemId, taskId: effectiveTask.id, reason, currentUser: currentUser?.fullName }),
      })
      setSkipOpen(false)
      setSkipPreset(null)
      setSkipNote('')
      setSelectedTaskId(null)
      setStepIndex(0)
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [skipPreset, skipNote, effectiveTask, subsystemId, currentUser, refresh])

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
  /* Deviceless tasks (firmware check, network loop) cover the whole MCM — there
     is no device to glow/zoom to. Dim the SCADA canvas and badge the HUD so the
     inert map reads as "subsystem-wide pre-flight", not broken highlighting. */
  const isSubsystemScope = !!effectiveTask && !focusName

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
              {/* Phase→Segment→Task are the dim breadcrumb; the Step is the
                  dominant line (spec: most emphasis on the current Step). */}
              <span className="gt-context-crumb">Phase: {effectiveTask.phase}</span>
              <span className="gt-context-crumb">Segment: {effectiveTask.segment}</span>
              <span className="gt-context-crumb">Task: {effectiveTask.title}</span>
              {currentStep && (
                <span className="gt-context-step">
                  Step: {currentStep.title}
                  {steps.length > 0 && (
                    <span className="gt-context-stepcount">
                      Step {stepIndex + 1} of {steps.length}
                    </span>
                  )}
                </span>
              )}
            </div>
          ) : (
            <div className="gt-context-lines">
              <span>No task in progress</span>
            </div>
          )}
        </div>
        <div className="gt-header-right">
          {/* D5: always-visible ring health chip (the fault overlay is the hard gate) */}
          <span
            className={`gt-ring-chip gt-ring-chip-${sysStatus.ring?.state ?? 'unknown'}`}
            title={sysStatus.ring?.reason ?? 'No ring reading yet'}
          >
            ● DPM RING {(sysStatus.ring?.state ?? 'unknown').toUpperCase()}
          </span>
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

      {pool?.readiness && pool.readiness.blockers.length > 0 && (
        // Hard blockers: guided mode can't generate its core (IO-check) tasks.
        // This is the fix for the silent-degradation gotcha — a missing or
        // wrong-MCM map used to produce an empty/misleading task list with no
        // explanation. Always shown (not dismissible) until resolved.
        <div className="gt-readiness gt-readiness-blocked" role="alert">
          <div className="gt-readiness-title">⚠ Guided mode is not fully set up</div>
          <ul className="gt-readiness-list">
            {pool.readiness.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          <div className="gt-readiness-actions">
            <Link className="gt-btn gt-btn-ghost gt-chip" to={`/commissioning/${subsystemId}`}>
              Open Settings / Pull diagram
            </Link>
          </div>
        </div>
      )}
      {pool?.readiness &&
        pool.readiness.blockers.length === 0 &&
        pool.readiness.warnings.length > 0 &&
        !readinessDismissed && (
          <div className="gt-readiness gt-readiness-warn" role="status">
            <ul className="gt-readiness-list">
              {pool.readiness.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <button
              className="gt-btn gt-btn-ghost gt-chip"
              onClick={() => setReadinessDismissed(true)}
            >
              Dismiss
            </button>
          </div>
        )}

      <div className="gt-body">
        <div className={isSubsystemScope ? 'gt-map-layer gt-map-layer--dimmed' : 'gt-map-layer'}>
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
                  return
                }
                // Locked / not part of the current task → non-blocking hint
                // instead of a silent no-op.
                showToast(
                  focusName && name === focusName
                    ? 'This device belongs to the current step — use the controls below.'
                    : 'Not part of this task — finish the current step first.',
                )
              }}
              lockedDevices={lockedDevices}
            />
          ) : (
            <div className="gt-map-fallback">&lt;map unavailable&gt;</div>
          )}
        </div>

        {swap && currentStep?.kind === 'io_check' && !popup && (
          <div className="gt-swap-banner" role="alert">
            <div className="gt-swap-title">
              ⚠ {swap.confidence === 'high' ? 'SWAP DETECTED' : 'POSSIBLE WRONG WIRING'}
            </div>
            <div className="gt-swap-detail">
              Expected <strong>{currentStep?.ioName}</strong> but <strong>{swap.ioName}</strong>{' '}
              triggered instead{swap.spare ? ' — a SPARE point' : ''}.
            </div>
            <div className="gt-swap-actions">
              <button className="gt-btn gt-btn-ghost" disabled={busy} onClick={dismissSwap}>
                DISMISS
              </button>
              <button className="gt-btn gt-btn-warn" disabled={busy} onClick={() => void acceptSwap()}>
                ACCEPT — FAIL WITH COMMENT
              </button>
            </div>
          </div>
        )}

        {effectiveTask && currentStep && (
          <div className={`gt-hud gt-hud-${currentStep.kind}`}>
            {isSubsystemScope && (
              <div className="gt-hud-scope">Subsystem-wide task — no single map location</div>
            )}
            {steps.length > 0 && (
              <div className="gt-hud-stepcount">
                Step {stepIndex + 1} of {steps.length}
              </div>
            )}
            <div className="gt-hud-step">{currentStep.title}</div>
            {currentStep.instruction && <p className="gt-hud-instruction">{currentStep.instruction}</p>}
            {effectiveTask.type === 'functional_check' &&
            currentStep.kind !== 'navigate' &&
            sysStatus.systemRunning === false ? (
              // D4: functional checks are meaningless while the system is
              // stopped — disable the step with a "Start the system" prompt.
              <div className="gt-sysrun-block" role="alert">
                <div className="gt-sysrun-title">⏸ SYSTEM STOPPED</div>
                <p className="gt-hud-instruction">
                  Start the system — all conveyors running — before performing functional checks.
                  This step unlocks automatically once a run signal is seen.
                </p>
              </div>
            ) : (
              renderStepBody({
                step: currentStep,
                isLast: stepIndex >= steps.length - 1,
                busy,
                liveState,
                seqPhase,
                estopVerdict,
                firmwareVerdict,
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
              })
            )}
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
          <button
            className="gt-btn gt-skip"
            onClick={() => {
              setSkipPreset(null)
              setSkipNote('')
              setSkipOpen(true)
            }}
            disabled={busy}
          >
            SKIP TASK
          </button>
        )}

        {/* Locked-device tap feedback — brief, non-blocking, auto-dismiss. */}
        {toast && (
          <div className="gt-toast" role="status" aria-live="polite">
            <span className="gt-toast-icon">🔒</span>
            <span>{toast}</span>
          </div>
        )}
      </div>

      {/* D5: the DPM ring is the backbone of every downstream check — a
          confirmed ring fault halts guided mode with an unmissable overlay
          ("this should be made extremely obvious to the tester"). */}
      {ringDegraded && (
        <div className="gt-ring-overlay" role="alertdialog" aria-label="DPM ring fault">
          <div className="gt-ring-card">
            <div className="gt-ring-icon">⚠</div>
            <div className="gt-ring-title">DPM RING FAULT — GUIDED MODE PAUSED</div>
            <p className="gt-ring-msg">
              The DLR ring is not nominal{sysStatus.ring?.reason ? ` — ${sysStatus.ring.reason}` : ''}.
              {sysStatus.ring?.lastActiveNode1 || sysStatus.ring?.lastActiveNode2
                ? ` Break is between ${sysStatus.ring?.lastActiveNode1 ?? '?'} and ${sysStatus.ring?.lastActiveNode2 ?? '?'}.`
                : ''}
            </p>
            <p className="gt-ring-msg gt-ring-msg-dim">
              Guided mode cannot function until ring health is restored. Fix the ring (check the
              break, reseat connections), then this banner clears automatically.
            </p>
            <div className="gt-actions-center">
              <button className="gt-btn gt-btn-ghost" onClick={() => navigate(`/commissioning/${subsystemId}`)}>
                Exit guided mode
              </button>
              <button className="gt-btn gt-btn-primary" onClick={() => setViewerOpen(true)}>
                Open Task Viewer
              </button>
            </div>
          </div>
        </div>
      )}

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
            {/* D9: preset reasons + optional note (free text only for Other) */}
            <label className="gt-field-label">Reason (required)</label>
            <div className="gt-skip-presets" role="radiogroup" aria-label="Skip reason">
              {SKIP_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={skipPreset === r}
                  className={`gt-skip-preset${skipPreset === r ? ' gt-skip-preset-active' : ''}`}
                  onClick={() => setSkipPreset(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            <label className="gt-field-label" htmlFor="gt-skip-note">
              {skipPreset === 'Other' ? 'Describe the reason (required)' : 'Note (optional)'}
            </label>
            <textarea
              id="gt-skip-note"
              className="gt-textarea"
              rows={2}
              value={skipNote}
              onChange={(e) => setSkipNote(e.target.value)}
              placeholder={skipPreset === 'Other' ? 'Why are you skipping this task?' : 'Anything worth recording?'}
            />
            <div className="gt-dialog-actions">
              <button className="gt-btn gt-btn-ghost" onClick={() => setSkipOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="gt-btn gt-btn-warn" onClick={submitSkip} disabled={busy || !skipReasonValid}>
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

/** Live firmware-compliance verdict for the firmware-check auto_detect step. */
type FirmwareVerdict = {
  verdict: 'pass' | 'fail' | 'unknown'
  nonCompliant: number
  deviceCount: number
  scanned: boolean
} | null

interface BodyProps {
  step: Step
  isLast: boolean
  busy: boolean
  liveState: string | null
  seqPhase: RoundTrip['phase']
  estopVerdict: EstopVerdict
  firmwareVerdict: FirmwareVerdict
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

/**
 * D6 round-trip progress: two stages (actuate → release), each ticking as the
 * PLC confirms the transition. NC: block/pull then clear/reset; NO: press then
 * release. A warning shows when an NC point reads FALSE at rest.
 */
function SequenceProgress({
  step,
  seqPhase,
  liveState,
}: {
  step: Step
  seqPhase: RoundTrip['phase']
  liveState: string | null
}) {
  const circuit = step.circuit ?? 'NO'
  const hint = sequenceHint(circuit)
  const actuated = seqPhase === 'await_return' || seqPhase === 'complete'
  const returned = seqPhase === 'complete'
  const idleMismatch =
    circuit === 'NC' && seqPhase === 'arming' && liveState === 'FALSE'
  // Plain-language explanation of the circuit type for non-engineers.
  const circuitPlain =
    circuit === 'NC'
      ? 'Normally-closed: sits ON (TRUE) at rest. Block / pull it so the signal drops, then release so it returns.'
      : 'Normally-open: sits OFF (FALSE) at rest. Press / actuate it so the signal rises, then release.'
  return (
    <div className="gt-seq">
      <div className="gt-seq-row">
        <span className={`gt-seq-stage${actuated ? ' gt-seq-done' : ''}`} title={hint.actuate}>
          {actuated ? '✓' : '1'} {hint.actuate}
        </span>
        <span className={`gt-seq-stage${returned ? ' gt-seq-done' : ''}`} title={hint.release}>
          {returned ? '✓' : '2'} {hint.release}
        </span>
      </div>
      <div className="gt-seq-meta">
        <span className="gt-seq-circuit" title={circuitPlain}>
          {circuit === 'NC' ? 'NC (normally-closed)' : 'NO (normally-open)'} · rests{' '}
          {circuit === 'NC' ? 'TRUE' : 'FALSE'}
        </span>
        <span className="gt-seq-plain">{circuitPlain}</span>
      </div>
      {idleMismatch && (
        <div className="gt-seq-warn" role="alert">
          ⚠ Expected TRUE at rest (NC) but reading FALSE — possible miswire/misconfiguration.
        </div>
      )}
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

  // 2) Device IO check — D6 round-trip auto-pass (actuate AND release);
  //    manual PASS override; "Nothing Happened" = Fail + punchlist (D7).
  if (step.kind === 'io_check') {
    return (
      <>
        <LiveSignal liveState={p.liveState} />
        <SequenceProgress step={step} seqPhase={p.seqPhase} liveState={p.liveState} />
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

  // 3) auto_detect — firmware compliance (live verdict from /api/firmware) or
  //    e-stop EPC (live auto-verdict + record).
  if (step.kind === 'auto_detect' && step.verdictSource === '/api/firmware') {
    const fv = p.firmwareVerdict
    const v = fv?.verdict ?? 'unknown'
    const tone = v === 'pass' ? 'gt-verdict-pass' : v === 'fail' ? 'gt-verdict-fail' : 'gt-verdict-unknown'
    const label = !fv || !fv.scanned
      ? 'SCANNING…'
      : v === 'pass'
        ? `ALL ${fv.deviceCount} COMPLIANT`
        : `${fv.nonCompliant} NON-COMPLIANT`
    return (
      <>
        <div className={`gt-verdict ${tone}`}>
          Firmware: <strong>{label}</strong>
        </div>
        <div className="gt-actions-center">
          <button className="gt-btn gt-btn-pass gt-btn-lg" disabled={p.busy} onClick={() => p.recordWithPopup('Passed')}>
            RECORD PASS
          </button>
          <button className="gt-btn gt-btn-warn gt-btn-lg" disabled={p.busy} onClick={() => p.recordWithPopup('Failed', 'Firmware non-compliant')}>
            RECORD FAIL
          </button>
        </div>
        <div className="gt-actions-center">
          <button
            className="gt-btn gt-btn-ghost gt-chip"
            disabled={p.busy}
            onClick={() => void fetch('/api/firmware/scan', { method: 'POST' }).catch(() => {})}
            title="Kick a fresh scan; the verdict above refreshes automatically"
          >
            RE-SCAN
          </button>
          <Link className="gt-link" to="/firmware">
            Per-device detail ↗
          </Link>
        </div>
      </>
    )
  }
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

  // Output device (beacon / horn / solenoid): can't be input-round-tripped.
  // Fire the output, visually/audibly confirm, then Pass/Fail (records against
  // step.ioId via /api/guided/test, same as any IO result).
  if (step.isOutput && step.fireOutputIoId) {
    const fireId = step.fireOutputIoId
    return (
      <div className="gt-actions-center gt-actions-stack">
        <button
          className="gt-btn gt-btn-primary gt-btn-lg"
          disabled={p.busy}
          onClick={() => {
            void fetch(`/api/ios/${fireId}/fire-output`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'toggle' }),
            }).catch(() => {})
          }}
        >
          FIRE OUTPUT
        </button>
        <div className="gt-actions-center">
          <button className="gt-btn gt-btn-pass gt-btn-lg" disabled={p.busy} onClick={() => p.recordWithPopup('Passed')}>
            PASS
          </button>
          <button className="gt-btn gt-btn-warn gt-btn-lg" disabled={p.busy} onClick={() => p.recordWithPopup('Failed', 'No Response')}>
            FAIL
          </button>
        </div>
      </div>
    )
  }

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
          <button
            className="gt-btn gt-btn-ghost"
            disabled={p.busy}
            title="Records N/A (skipped) for this column and moves on — e.g. SCADA checks done separately"
            onClick={() =>
              isFunctional ? p.recordFunctionalValue(SKIP_STEP_VALUE) : p.recordVfdColumn(SKIP_STEP_VALUE)
            }
          >
            SKIP STEP
          </button>
        </div>
      )
    }
    // pass_fail — pure prompt & response (D1): the tester is the verdict.
    return (
      <>
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
        <div className="gt-actions-center">
          <button
            className="gt-btn gt-btn-ghost"
            disabled={p.busy}
            title="Records N/A (skipped) for this column and moves on — e.g. SCADA checks done separately"
            onClick={() =>
              isFunctional ? p.recordFunctionalValue(SKIP_STEP_VALUE) : p.recordVfdColumn(SKIP_STEP_VALUE)
            }
          >
            SKIP STEP
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
