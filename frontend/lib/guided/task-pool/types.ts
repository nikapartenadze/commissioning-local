/**
 * Guided-Mode Task Pool — type model.
 *
 * Implements the hierarchy from the Guided Mode spec:
 *
 *   Phase   → high-level section of a project
 *             (Mechanical Installation, Electrical Installation,
 *              Commissioning, Testing)
 *   Segment → a section of a phase
 *             (Network Verification, Safety Device I/O Check, …)
 *   Task    → a digestible action for the tester (e.g. "IO Check EPC1-PS1-1").
 *             Many Tasks make up a Segment. A Task contains one or more Steps.
 *   Step    → the smallest direction sent to the user. One Step is delivered
 *             at a time in guided mode. A Task isn't complete until all of its
 *             Steps have passed.
 *
 * The engine works as a *pool*: every candidate Task is computed from the
 * current data snapshot, each Task is gated by its dependencies, and the
 * tester is always handed the highest-priority *available* Task next.
 */

export type Phase =
  | 'Mechanical Installation'
  | 'Electrical Installation'
  | 'Commissioning'
  | 'Testing'

/** Segments of the Commissioning phase, in commissioning flow order. */
export type Segment =
  | 'Network Verification'
  | 'VFD Commissioning'
  | 'Safety Device I/O Check'
  | 'Safety Verification'
  | 'Non-Safety Device I/O Check'
  | 'Functional Validation'

/**
 * The six task families from the spec, listed highest → lowest priority.
 * Priority follows the flow of commissioning (see priority.ts).
 */
export type TaskType =
  | 'network_loop'
  | 'vfd_setup'
  | 'io_check_safety'
  | 'estop_verification'
  | 'io_check_nonsafety'
  | 'functional_check'

/**
 * Lifecycle state of a Task in the pool.
 *  - available   : every dependency satisfied, no work recorded yet
 *  - in_progress : some sub-results recorded, not all
 *  - completed   : all sub-results recorded (derived from underlying data)
 *  - blocked     : at least one dependency unmet — not yet in the live pool
 *  - skipped     : tester skipped it (reason captured)
 */
export type TaskState =
  | 'available'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'skipped'

/**
 * The kind of a Step controls how the guided UI renders + advances it.
 *  - navigate     : show the mini-map, "I'm There" advances
 *  - io_check     : watch a PLC tag; auto pass on actuation, "Nothing
 *                   Happened" fails. Acknowledged via a popup.
 *  - auto_detect  : a programmatic verdict is polled (e.g. e-stop drop)
 *  - manual_confirm : tester confirms a procedure was done (pass/fail)
 *  - info         : informational, "Continue" advances
 */
export type StepKind =
  | 'navigate'
  | 'io_check'
  | 'auto_detect'
  | 'manual_confirm'
  | 'info'

export interface Step {
  /** Stable id within the task (e.g. `${taskId}:step:2`). */
  id: string
  kind: StepKind
  /** Big headline shown to the tester, e.g. "STEP 2: FLAG PHOTOEYE". */
  title: string
  /** Supporting instruction text under the headline. */
  instruction?: string
  /** Device this step centers the mini-map on, if any. */
  deviceName?: string
  /** For io_check steps: the IO row being verified. */
  ioId?: number
  ioName?: string | null
  /**
   * For auto_detect steps: the endpoint the UI should poll for a verdict,
   * plus an opaque key the verdict is keyed on (e.g. an EPC check tag).
   */
  verdictSource?: string
  verdictKey?: string
}

export interface Task {
  /** Stable, deterministic id (so skips/results survive a rebuild). */
  id: string
  type: TaskType
  phase: Phase
  segment: Segment
  /** Priority rank (1 = highest). Derived from TaskType. */
  priority: number
  /** Human title, e.g. "IO Check EPC1-PS1-1". */
  title: string
  /** Primary device the task acts on, when applicable. */
  deviceName?: string
  state: TaskState
  /** Ordered steps. Empty until the task is opened (built lazily server-side). */
  steps: Step[]
  /**
   * Human-readable dependencies that are NOT yet satisfied. Empty when the
   * task is available/in_progress/completed. Shown in the Task Viewer so the
   * tester understands *why* a task is still locked.
   */
  unmetDependencies: string[]
  /** Captured when the tester skips the task. */
  skipReason?: string
  /** Progress within the task, 0..1 (sub-results recorded / total). */
  progress: number
}

export interface TaskPoolSummary {
  total: number
  available: number
  inProgress: number
  completed: number
  blocked: number
  skipped: number
}

export interface TaskPool {
  subsystemId: number
  tasks: Task[]
  /** Id of the highest-priority available/in-progress task, or null. */
  nextTaskId: string | null
  summary: TaskPoolSummary
}
