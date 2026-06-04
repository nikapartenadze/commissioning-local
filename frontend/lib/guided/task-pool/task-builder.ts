import type {
  DataSnapshot,
  SnapshotDevice,
  SnapshotEstopZone,
  SnapshotFunctional,
  SnapshotVfd,
} from './snapshot-types'
import type { Phase, Segment, Task, TaskPool, TaskPoolSummary, TaskState, TaskType } from './types'
import { pickNextTask, priorityOf } from './priority'

/**
 * Pure task-pool builder. Turns a DataSnapshot into the full prioritised
 * pool of Tasks, each stamped with its lifecycle state, unmet dependencies
 * and progress. No DB / PLC / network access — see snapshot.ts for the
 * impure loader that feeds this.
 */

const PHASE: Phase = 'Commissioning'

const SEGMENT_FOR: Record<TaskType, Segment> = {
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

function vfdComplete(v: SnapshotVfd): { done: number; total: number } {
  const total = v.steps.length + 1 // +1 for "Controls Verified"
  let done = v.steps.filter((s) => s.value != null && s.value !== '').length
  if (v.controlsVerified) done += 1
  return { done, total }
}

function buildVfdTasks(snapshot: DataSnapshot, networkLoopDone: boolean): RawTask[] {
  return [...snapshot.vfds]
    .sort((a, b) => a.order - b.order)
    .map((v) => {
      const { done, total } = vfdComplete(v)
      const unmet: string[] = []
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
): RawTask[] {
  const type: TaskType = safety ? 'io_check_safety' : 'io_check_nonsafety'
  return [...snapshot.devices]
    .filter((d) => d.isSafety === safety && d.ios.length > 0)
    .sort((a, b) => a.order - b.order)
    .map((d) => {
      const { done, total } = deviceTestable(d)
      const unmet: string[] = []
      if (!networkLoopDone) unmet.push('All Network Loop tasks must be done')
      if (d.installComplete === false) unmet.push(`${d.deviceName} must be 100% installed`)
      if (d.networked === false) unmet.push(`${d.deviceName} must be networked and communicating`)
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
): RawTask[] {
  return snapshot.estopZones
    .filter((z) => z.epcs.length > 0)
    .map((z: SnapshotEstopZone) => {
      const total = z.epcs.length
      const done = z.epcs.filter((e) => e.result === 'pass' || e.result === 'fail').length
      const unmet: string[] = []
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
    .map((f: SnapshotFunctional) => ({
      id: taskId('functional_check', `${f.sheetName}:${f.deviceName}`),
      type: 'functional_check' as TaskType,
      title: `${f.displayName} Check: ${f.deviceName}`,
      deviceName: f.deviceName,
      done: f.completedChecks,
      total: f.totalChecks,
      unmet: [...globalUnmet],
    }))
}

// ── Orchestration ────────────────────────────────────────────────────────

export function buildTaskPool(snapshot: DataSnapshot): TaskPool {
  const tasks: Task[] = []

  // 1) Network loop (priority 1) — gates everything downstream.
  const rawNetwork = buildNetworkTask(snapshot)
  const networkTask = rawNetwork ? finalize(rawNetwork, snapshot) : null
  if (networkTask) tasks.push(networkTask)
  // If there is no ring to verify, downstream "network loop done" is vacuously
  // true — there is nothing to wait on.
  const networkLoopDone = networkTask ? isComplete(networkTask) : true

  // 2) VFD setup (priority 2)
  const vfdTasks = buildVfdTasks(snapshot, networkLoopDone).map((r) => finalize(r, snapshot))
  tasks.push(...vfdTasks)

  // 3) IO Check — Safety (priority 3)
  const safetyTasks = buildIoCheckTasks(snapshot, true, networkLoopDone).map((r) =>
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
  const estopTasks = buildEstopTasks(snapshot, allSafetyIoDone, safetyDoneByDevice).map((r) =>
    finalize(r, snapshot),
  )
  tasks.push(...estopTasks)

  // 5) IO Check — Non-Safety (priority 5)
  const nonSafetyTasks = buildIoCheckTasks(snapshot, false, networkLoopDone).map((r) =>
    finalize(r, snapshot),
  )
  tasks.push(...nonSafetyTasks)

  // 6) Functional Checks (priority 6)
  const functionalGlobalUnmet: string[] = []
  if (snapshot.allNetworkedCommunicating === false) {
    functionalGlobalUnmet.push('All networked items must be communicating')
  }
  if (snapshot.beltsTracked === false) {
    functionalGlobalUnmet.push('All belts must be tracked')
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
