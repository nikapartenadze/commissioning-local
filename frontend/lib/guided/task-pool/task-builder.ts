import type {
  DataSnapshot,
  SnapshotDevice,
  SnapshotEstopZone,
  SnapshotFunctional,
  SnapshotVfd,
} from './snapshot-types'
import type {
  Phase,
  Segment,
  Task,
  TaskPool,
  TaskPoolReadiness,
  TaskPoolSummary,
  TaskState,
  TaskType,
} from './types'
import { pickNextTask, priorityOf } from './priority'
import { associatedIosFor, pendingAssociatedLabels } from './associations'
import { precheckFailure } from '@/lib/guided/io-check-sequence'

/**
 * D5 (committee): guided mode cannot function when the DPM ring is not
 * nominal. A confirmed-degraded ring gates every task downstream of the
 * network loop; 'unknown'/null never blocks (no PLC / no DLR probe yet).
 */
export const RING_DEGRADED_DEP = 'DPM ring health must be nominal (ring is FAULTED)'

/** D4 (committee): functional checks need the system started + running. */
export const SYSTEM_STOPPED_DEP = 'System must be started — all conveyors running'

/**
 * Pure task-pool builder. Turns a DataSnapshot into the full prioritised
 * pool of Tasks, each stamped with its lifecycle state, unmet dependencies
 * and progress. No DB / PLC / network access — see snapshot.ts for the
 * impure loader that feeds this.
 */

const PHASE: Phase = 'Commissioning'

const SEGMENT_FOR: Record<TaskType, Segment> = {
  firmware_check: 'Firmware Compliance',
  network_loop: 'Network Verification',
  vfd_setup: 'VFD Commissioning',
  io_check_safety: 'Safety Device I/O Check',
  estop_verification: 'Safety Verification',
  io_check_nonsafety: 'Non-Safety Device I/O Check',
  functional_check: 'Functional Validation',
}

/** Deterministic, rebuild-stable id so skips/manual status survive a refresh. */
export function taskId(type: TaskType, key: string): string {
  return `${type}:${key}`
}

interface RawTask {
  id: string
  type: TaskType
  title: string
  deviceName?: string
  /** Sub-results recorded. */
  done: number
  /** Total sub-results expected (≥1). */
  total: number
  /** Dependencies unmet purely from gating signals (filled by caller). */
  unmet: string[]
}

function finalize(raw: RawTask, snapshot: DataSnapshot): Task {
  const manual = snapshot.manualTaskStatus[raw.id]
  const progress = raw.total > 0 ? raw.done / raw.total : 0
  const derivedComplete = raw.total > 0 && raw.done >= raw.total

  let state: TaskState
  if (manual?.status === 'skipped') {
    state = 'skipped'
  } else if (manual?.status === 'completed' || derivedComplete) {
    state = 'completed'
  } else if (raw.unmet.length > 0) {
    state = 'blocked'
  } else if (raw.done > 0) {
    state = 'in_progress'
  } else {
    state = 'available'
  }

  return {
    id: raw.id,
    type: raw.type,
    phase: PHASE,
    segment: SEGMENT_FOR[raw.type],
    priority: priorityOf(raw.type),
    title: raw.title,
    deviceName: raw.deviceName,
    state,
    steps: [],
    unmetDependencies: state === 'blocked' ? raw.unmet : [],
    skipReason: manual?.status === 'skipped' ? manual.reason : undefined,
    progress: state === 'completed' ? 1 : progress,
  }
}

function isComplete(t: Task): boolean {
  return t.state === 'completed'
}

// ── Per-type raw builders ────────────────────────────────────────────────

function buildNetworkTask(snapshot: DataSnapshot): RawTask | null {
  if (!snapshot.network.hasRings) return null
  const unmet: string[] = []
  if (snapshot.network.dpmsAllInstalled === false) {
    unmet.push('All DPMs must be marked 100% installed')
  }
  return {
    id: taskId('network_loop', String(snapshot.subsystemId)),
    type: 'network_loop',
    title: `Verify Network Loop${snapshot.mcm ? ` — ${snapshot.mcm}` : ''}`,
    done: 0, // completion is manual (no data backing); see snapshot.manualTaskStatus
    total: 1,
    unmet,
  }
}

/**
 * Firmware-compliance gate — one task per subsystem, emitted only when the
 * snapshot carries a firmware summary (i.e. firmware checking applies). It's a
 * manual gate (the tester scans on the Firmware Compliance page and confirms),
 * so completion is driven by manualTaskStatus exactly like the network loop —
 * `done`/`total` here only seed available/in_progress. It blocks nothing
 * downstream: wrong firmware is surfaced, not used to gate IO checks.
 */
function buildFirmwareTask(snapshot: DataSnapshot): RawTask | null {
  const fw = snapshot.firmware
  if (!fw) return null
  return {
    id: taskId('firmware_check', String(snapshot.subsystemId)),
    type: 'firmware_check',
    title: `Verify Firmware Compliance${snapshot.mcm ? ` — ${snapshot.mcm}` : ''}`,
    done: 0, // completion is manual (tester confirms after scanning)
    total: 1,
    unmet: [],
  }
}

function vfdComplete(v: SnapshotVfd): { done: number; total: number } {
  const total = v.steps.length + 1 // +1 for "Controls Verified"
  let done = v.steps.filter((s) => s.value != null && s.value !== '').length
  if (v.controlsVerified) done += 1
  return { done, total }
}

function buildVfdTasks(
  snapshot: DataSnapshot,
  networkLoopDone: boolean,
  ringDegraded: boolean,
): RawTask[] {
  return [...snapshot.vfds]
    .sort((a, b) => a.order - b.order)
    .map((v) => {
      const { done, total } = vfdComplete(v)
      const unmet: string[] = []
      if (ringDegraded) unmet.push(RING_DEGRADED_DEP)
      if (!networkLoopDone) unmet.push('All Network Loop tasks must be done')
      return {
        id: taskId('vfd_setup', v.deviceName),
        type: 'vfd_setup' as TaskType,
        title: `VFD Setup: ${v.deviceName}`,
        deviceName: v.deviceName,
        done,
        total: Math.max(total, 1),
        unmet,
      }
    })
}

function deviceTestable(d: SnapshotDevice): { done: number; total: number } {
  const total = d.ios.length
  const done = d.ios.filter((io) => io.result === 'Passed' || io.result === 'Failed').length
  return { done, total }
}

function buildIoCheckTasks(
  snapshot: DataSnapshot,
  safety: boolean,
  networkLoopDone: boolean,
  ringDegraded: boolean,
): RawTask[] {
  const type: TaskType = safety ? 'io_check_safety' : 'io_check_nonsafety'
  return [...snapshot.devices]
    .filter((d) => d.isSafety === safety && d.ios.length > 0)
    .sort((a, b) => a.order - b.order)
    .map((d) => {
      const { done, total } = deviceTestable(d)
      const unmet: string[] = []
      if (ringDegraded) unmet.push(RING_DEGRADED_DEP)
      if (!networkLoopDone) unmet.push('All Network Loop tasks must be done')
      if (d.installComplete === false) unmet.push(`${d.deviceName} must be 100% installed`)
      if (d.networked === false) unmet.push(`${d.deviceName} must be networked and communicating`)
      // D6 pre-check: an IO-check item can't enter the queue while an NC point
      // reads FALSE at rest — that's a misconfigured/miswired device, and the
      // blocked reason surfaces it in the Task Viewer. Only applies to points
      // that still need a result (a recorded result supersedes the pre-check).
      for (const io of d.ios) {
        if (io.result != null) continue
        const fail = precheckFailure(io.circuit, io.liveState, io.name || io.description || 'IO')
        if (fail) {
          unmet.push(`Pre-check failed: ${fail}`)
          break // one message per device is enough to block + explain
        }
      }
      return {
        id: taskId(type, d.deviceName),
        type,
        title: `IO Check ${d.deviceName}`,
        deviceName: d.deviceName,
        done,
        total,
        unmet,
      }
    })
}

function buildEstopTasks(
  snapshot: DataSnapshot,
  allSafetyIoDone: boolean,
  safetyDoneByDevice: Map<string, boolean>,
  ringDegraded: boolean,
): RawTask[] {
  return snapshot.estopZones
    .filter((z) => z.epcs.length > 0)
    .map((z: SnapshotEstopZone) => {
      // Dual-safety: each EPC has TWO checks (preliminary zone-stop + final
      // selectivity). Count each as a progress unit so the task reads
      // in_progress while half-done and completed only when BOTH are recorded
      // for every EPC.
      const total = z.epcs.length * 2
      let done = 0
      for (const e of z.epcs) {
        if (e.result === 'pass' || e.result === 'fail') done++
        if (e.finalResult === 'pass' || e.finalResult === 'fail') done++
      }
      const unmet: string[] = []
      if (ringDegraded) unmet.push(RING_DEGRADED_DEP)
      // Prefer per-zone gating: only the safety devices in THIS zone must be
      // checked. Fall back to the global rule when no device could be mapped.
      const mapped = z.safetyDeviceNames.filter((d) => safetyDoneByDevice.has(d))
      if (mapped.length > 0) {
        const pending = mapped.filter((d) => !safetyDoneByDevice.get(d))
        if (pending.length > 0) {
          const shown = pending.slice(0, 3).join(', ')
          unmet.push(
            `Safety I/O Check must be done for ${shown}${pending.length > 3 ? ` +${pending.length - 3} more` : ''}`,
          )
        }
      } else if (!allSafetyIoDone) {
        unmet.push('All Safety I/O Check tasks must be done first')
      }
      return {
        id: taskId('estop_verification', z.zoneName),
        type: 'estop_verification' as TaskType,
        title: `E-Stop Verification: ${z.zoneName}`,
        done,
        total: Math.max(total, 1),
        unmet,
      }
    })
}

function buildFunctionalTasks(
  snapshot: DataSnapshot,
  globalUnmet: string[],
): RawTask[] {
  return [...snapshot.functional]
    .filter((f) => f.totalChecks > 0)
    .sort((a, b) => a.order - b.order)
    .map((f: SnapshotFunctional) => {
      const unmet = [...globalUnmet]
      // D3 (committee Option A): a functional check enters the pool only when
      // its ASSOCIATED devices (the JPE + its beacon + its JR pushbutton, …)
      // have been IO checked. Association is derived from the shared location
      // prefix in the tag names; no prefix / no matches → global rules only.
      const associated = associatedIosFor(f.deviceName, snapshot.devices)
      const pending = pendingAssociatedLabels(associated)
      if (pending.length > 0) {
        const shown = pending.slice(0, 3).join(', ')
        unmet.push(
          `Associated devices must pass IO check first: ${shown}${pending.length > 3 ? ` +${pending.length - 3} more` : ''}`,
        )
      }
      return {
        id: taskId('functional_check', `${f.sheetName}:${f.deviceName}`),
        type: 'functional_check' as TaskType,
        title: `${f.displayName} Check: ${f.deviceName}`,
        deviceName: f.deviceName,
        done: f.completedChecks,
        total: f.totalChecks,
        unmet,
      }
    })
}

// ── Readiness diagnostics ──────────────────────────────────────────────────

/**
 * Compute up-front readiness from the snapshot. This is what stops guided mode
 * from silently degrading: a missing/mismatched device map or a faulted ring is
 * surfaced to the tester instead of producing a quietly-broken task list.
 */
export function computeReadiness(snapshot: DataSnapshot): TaskPoolReadiness {
  const deviceCount = snapshot.devices.filter((d) => d.ios.length > 0).length
  const blockers: string[] = []
  const warnings: string[] = []

  if (snapshot.mapSource === 'none') {
    blockers.push(
      'No device map is loaded for this MCM — guided I/O checks cannot be generated. ' +
        "Set the project API key in Settings, then use “Pull diagram”.",
    )
  } else if (deviceCount === 0 && snapshot.ioCount > 0) {
    // There ARE I/O points for this subsystem but the map resolved none of them
    // → the loaded map's element ids don't match this MCM's device naming.
    blockers.push(
      `The loaded device map resolved 0 of ${snapshot.ioCount} I/O points for this MCM — ` +
        'the map likely belongs to a different subsystem. Pull the correct diagram for this MCM.',
    )
  } else if (snapshot.mapSource === 'bundled-fallback' && deviceCount > 0) {
    warnings.push(
      'Using a generic bundled map (no per-MCM diagram found). Device positions may be ' +
        'approximate — pull this subsystem’s diagram to be sure I/O checks are complete.',
    )
  }

  if (!snapshot.plcConnected) {
    warnings.push(
      'PLC not connected — automatic device detection is unavailable. You can still record ' +
        'results manually, but the live round-trip auto-pass will not fire.',
    )
  }

  if (snapshot.ringHealth === 'degraded') {
    warnings.push(
      'DPM ring is FAULTED — every task downstream of the network loop is locked until the ' +
        'ring is nominal.',
    )
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    mapSource: snapshot.mapSource,
    deviceCount,
    plcConnected: snapshot.plcConnected,
  }
}

// ── Orchestration ────────────────────────────────────────────────────────

export function buildTaskPool(snapshot: DataSnapshot): TaskPool {
  const tasks: Task[] = []

  // D5: a confirmed-degraded DPM ring gates EVERYTHING downstream of the
  // network loop ("guided mode cannot function if DPM ring health is not
  // nominal"). 'unknown'/null is non-blocking — no PLC or no DLR probe yet.
  const ringDegraded = snapshot.ringHealth === 'degraded'

  // 0) Firmware compliance (priority 1, id tie-break hands it first) — a
  // one-shot hardware gate. Independent: blocks nothing, gated by nothing.
  // Only present when the snapshot carries a firmware summary.
  const rawFirmware = buildFirmwareTask(snapshot)
  if (rawFirmware) tasks.push(finalize(rawFirmware, snapshot))

  // 1) Network loop (priority 1) — gates everything downstream.
  const rawNetwork = buildNetworkTask(snapshot)
  const networkTask = rawNetwork ? finalize(rawNetwork, snapshot) : null
  if (networkTask) tasks.push(networkTask)
  // If there is no ring to verify, downstream "network loop done" is vacuously
  // true — there is nothing to wait on.
  const networkLoopDone = networkTask ? isComplete(networkTask) : true

  // 2) VFD setup (priority 2)
  const vfdTasks = buildVfdTasks(snapshot, networkLoopDone, ringDegraded).map((r) =>
    finalize(r, snapshot),
  )
  tasks.push(...vfdTasks)

  // 3) IO Check — Safety (priority 3)
  const safetyTasks = buildIoCheckTasks(snapshot, true, networkLoopDone, ringDegraded).map((r) =>
    finalize(r, snapshot),
  )
  tasks.push(...safetyTasks)
  const allSafetyIoDone =
    safetyTasks.length === 0 || safetyTasks.every(isComplete)
  // device → is its safety IO check complete (for per-zone e-stop gating)
  const safetyDoneByDevice = new Map<string, boolean>()
  for (const t of safetyTasks) {
    if (t.deviceName) safetyDoneByDevice.set(t.deviceName, isComplete(t))
  }

  // 4) E-Stop Verification (priority 4)
  const estopTasks = buildEstopTasks(snapshot, allSafetyIoDone, safetyDoneByDevice, ringDegraded).map(
    (r) => finalize(r, snapshot),
  )
  tasks.push(...estopTasks)

  // 5) IO Check — Non-Safety (priority 5)
  const nonSafetyTasks = buildIoCheckTasks(snapshot, false, networkLoopDone, ringDegraded).map((r) =>
    finalize(r, snapshot),
  )
  tasks.push(...nonSafetyTasks)

  // 6) Functional Checks (priority 6)
  // PHASE GATE (user choice "two locked phases"): IO Checkout is Phase 1
  // (Network → VFD → IO Safety → E-Stop → IO Non-Safety); Functional
  // Validation is Phase 2 and stays LOCKED until every Phase-1 task is done —
  // i.e. completed or intentionally skipped. A still-blocked Phase-1 task keeps
  // Phase 2 locked on purpose ("IO has to be done first"); its own reason
  // surfaces in the Task Viewer. Phase 2 unlocks automatically once Phase 1 is
  // clear.
  const phase1Tasks: Task[] = [
    ...(networkTask ? [networkTask] : []),
    ...vfdTasks,
    ...safetyTasks,
    ...estopTasks,
    ...nonSafetyTasks,
  ]
  const phase1Remaining = phase1Tasks.filter(
    (t) => t.state !== 'completed' && t.state !== 'skipped',
  ).length

  const functionalGlobalUnmet: string[] = []
  if (phase1Remaining > 0) {
    functionalGlobalUnmet.push(
      `Complete IO Checkout first — ${phase1Remaining} task${phase1Remaining === 1 ? '' : 's'} remaining (Phase 1)`,
    )
  }
  if (ringDegraded) functionalGlobalUnmet.push(RING_DEGRADED_DEP)
  if (snapshot.allNetworkedCommunicating === false) {
    functionalGlobalUnmet.push('All networked items must be communicating')
  }
  if (snapshot.beltsTracked === false) {
    functionalGlobalUnmet.push('All belts must be tracked')
  }
  // D4: functional checks are meaningless when the system is stopped. Gate
  // only on a confirmed-stopped verdict; unknown (no run tag) never blocks.
  if (snapshot.systemRunning === false) {
    functionalGlobalUnmet.push(SYSTEM_STOPPED_DEP)
  }
  const functionalTasks = buildFunctionalTasks(snapshot, functionalGlobalUnmet).map((r) =>
    finalize(r, snapshot),
  )
  tasks.push(...functionalTasks)

  const summary = summarize(tasks)
  const next = pickNextTask(tasks)

  return {
    subsystemId: snapshot.subsystemId,
    tasks,
    nextTaskId: next ? next.id : null,
    summary,
    readiness: computeReadiness(snapshot),
  }
}

export function summarize(tasks: Task[]): TaskPoolSummary {
  const s: TaskPoolSummary = {
    total: tasks.length,
    available: 0,
    inProgress: 0,
    completed: 0,
    blocked: 0,
    skipped: 0,
  }
  for (const t of tasks) {
    if (t.state === 'available') s.available++
    else if (t.state === 'in_progress') s.inProgress++
    else if (t.state === 'completed') s.completed++
    else if (t.state === 'blocked') s.blocked++
    else if (t.state === 'skipped') s.skipped++
  }
  return s
}
