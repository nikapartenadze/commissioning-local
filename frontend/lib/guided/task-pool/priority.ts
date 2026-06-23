import type { Task, TaskType } from './types'

/**
 * Task priority follows the flow of commissioning (Guided Mode spec, "Task
 * Pool"). Lower number = higher priority = handed to the tester first.
 *
 *   1. Network Loop Tasks          (highest priority in queue)
 *   2. IO Check Tasks (Safety)
 *   3. E-Stop Verification Tasks
 *   4. IO Check Tasks (Non-Safety)
 *   5. VFD Setup Tasks
 *   6. Functional Checks           (lowest priority in queue)
 *
 * NOTE: IO Checkout is intentionally ahead of VFD Setup (field request:
 * "IO has to be done first"). The engine does not gate IO checks on VFD, so
 * this ordering is safe. Functional Validation stays locked behind ALL of
 * Phase 1 (network → IO → e-stop → VFD) via the phase gate in task-builder.
 */
export const TASK_PRIORITY: Record<TaskType, number> = {
  network_loop: 1,
  io_check_safety: 2,
  estop_verification: 3,
  io_check_nonsafety: 4,
  vfd_setup: 5,
  functional_check: 6,
}

export function priorityOf(type: TaskType): number {
  return TASK_PRIORITY[type]
}

/**
 * The pool always hands the tester the highest-priority *workable* task.
 * "Workable" = available or in_progress (deps satisfied, not skipped, not
 * already complete). Ties broken by the task's natural ordering: priority,
 * then device/SVG order encoded in the task id.
 */
export function pickNextTask(tasks: Task[]): Task | null {
  const workable = tasks.filter(
    (t) => t.state === 'available' || t.state === 'in_progress',
  )
  if (workable.length === 0) return null
  workable.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    // in_progress before available at the same priority so a half-finished
    // task gets finished rather than abandoned for a fresh one.
    const aProg = a.state === 'in_progress' ? 0 : 1
    const bProg = b.state === 'in_progress' ? 0 : 1
    if (aProg !== bProg) return aProg - bProg
    return a.id.localeCompare(b.id, undefined, { numeric: true })
  })
  return workable[0]
}
