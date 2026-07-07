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
  | 'Firmware Compliance'
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
  | 'firmware_check'
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
 *  - io_check     : watch a PLC tag; auto pass on the full D6 round-trip
 *                   (actuate AND release), "Nothing Happened" fails.
 *                   Acknowledged via a popup.
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
   * For io_check steps: circuit type driving the D6 round-trip sequence.
   * NC rests TRUE (block → clear), NO rests FALSE (press → release).
   */
  circuit?: 'NC' | 'NO'
  /**
   * For auto_detect steps: the endpoint the UI should poll for a verdict,
   * plus an opaque key the verdict is keyed on (e.g. an EPC check tag).
   */
  verdictSource?: string
  verdictKey?: string

  // ── data-entry steps (VFD setup + functional checks) ──────────────
  /** L2 column being recorded (by name) — VFD wizard / functional. */
  l2Column?: string
  /** L2 device + column ids for a direct cell write (functional checks). */
  l2DeviceId?: number
  l2ColumnId?: number
  /** How the tester records this step. */
  inputType?: 'pass_fail' | 'number' | 'text'
  /** Current recorded value (so re-entering shows progress). */
  currentValue?: string | null
  /** This step records the VFD "Controls Verified" flag. */
  vfdControls?: boolean

  // ── e-stop per-EPC steps ──────────────────────────────────────────
  estopZone?: string
  estopCheckTag?: string
  estopEpcName?: string
  /**
   * Which of the dual-safety checks this auto_detect step records. The guided
   * walk verifies BOTH per EPC: 'preliminary' = the POSITIVE zone-stop check
   * (this EPC's own drives go to STO); 'final' = the NEGATIVE selectivity check
   * (other zones keep running). The runner reads the matching verdict from
   * /api/estop/status (preliminaryVerdict / finalVerdict) and posts the
   * matching `checkType` to /api/estop/check. Defaults to 'preliminary'.
   */
  estopCheckType?: 'preliminary' | 'final'

  /**
   * IO ids whose live PLC transitions should be watched on this step
   * (io_check only — functional checks are pure prompt/response per D1).
   * The step auto-passes when the full D6 round-trip sequence is seen.
   */
  watchIoIds?: number[]

  // ── output devices (beacons, horns, solenoids, …) ─────────────────
  /**
   * This step verifies an OUTPUT, which can't be checked by an input
   * round-trip. The runner offers a "Fire" button (POST /api/ios/:id/fire-output)
   * driving `fireOutputIoId`, the tester visually confirms, then passes/fails
   * via the acknowledgment popup.
   */
  isOutput?: boolean
  fireOutputIoId?: number

  // ── network-loop auto-verify assist (D5-adjacent) ─────────────────
  /**
   * Live DLR ring verdict surfaced on the Network Loop step. When 'healthy'
   * AND `dpmsCommunicating` the runner may auto-pass; 'unknown'/null never
   * blocks and the tester can always confirm manually.
   */
  ringVerdict?: 'healthy' | 'degraded' | 'unknown' | null
  dpmsCommunicating?: boolean | null
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
  /**
   * Display name of ANOTHER tester currently working this task (live claim).
   * Absent/null for unclaimed tasks and for the caller's own claim. The pool's
   * nextTaskId already skips other-claimed tasks so two testers on the same
   * MCM are never handed the same device.
   */
  claimedBy?: string | null
}

export interface TaskPoolSummary {
  total: number
  available: number
  inProgress: number
  completed: number
  blocked: number
  skipped: number
}

/** Where the device map (SVG) that drives IO-check tasks came from. */
export type MapSource = 'mcm-diagram' | 'bundled-fallback' | 'none'

/**
 * Readiness diagnostics — answers "can guided mode actually run for this MCM,
 * and is anything silently degraded?". Computed purely from the snapshot.
 *
 * Historically guided mode degraded silently: a missing or mismatched device
 * map produced 0 IO-check tasks with no feedback, so functional checks (the
 * lowest priority) looked "first" and the tester assumed guided mode was
 * broken. This block makes those conditions visible up-front.
 */
export interface TaskPoolReadiness {
  /** True when nothing blocks guided mode from generating its core tasks. */
  ready: boolean
  /** Hard problems that make whole categories of tasks impossible. */
  blockers: string[]
  /** Soft issues the tester can work around (manual entry still works). */
  warnings: string[]
  /** Where the device map came from (drives IO-check task generation). */
  mapSource: MapSource
  /** Devices (with at least one I/O point) the map resolved for this MCM. */
  deviceCount: number
  /** Live PLC tag data is flowing (required for auto-detect; not for manual). */
  plcConnected: boolean
}

export interface TaskPool {
  subsystemId: number
  tasks: Task[]
  /** Id of the highest-priority available/in-progress task, or null. */
  nextTaskId: string | null
  summary: TaskPoolSummary
  /** Up-front diagnostics on whether guided mode is set up + ready to run. */
  readiness: TaskPoolReadiness
  /**
   * Other testers' live claims on this MCM (never includes the caller's own).
   * The runner excludes these devices/IOs from swap detection so a colleague
   * actuating THEIR device doesn't fire a false wrong-wiring banner here.
   */
  claims?: ActiveClaimInfo[]
}

/** Public shape of another tester's live claim, embedded in the pool. */
export interface ActiveClaimInfo {
  taskId: string
  /** Display name when known, else a stable anonymous label. */
  user: string
  deviceName?: string | null
  /** IO ids the claimed task watches/tests — excluded from swap candidates. */
  watchIoIds?: number[]
}
