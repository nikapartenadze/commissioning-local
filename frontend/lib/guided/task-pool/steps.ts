import type { Step, Task } from './types'
import {
  classifyIoCircuit,
  classifyIoDeviceClass,
  deviceProcedure,
} from '@/lib/guided/io-check-sequence'

/**
 * Minimal IO shape the step-builder needs. Matches the `IoSummary` returned by
 * GET /api/guided/devices/:name, but kept local so this stays pure + testable.
 */
export interface StepIo {
  id: number
  name: string
  description: string | null
  result: 'Passed' | 'Failed' | null
  /**
   * True for OUTPUT points (beacons, horns, solenoids). Outputs can't be
   * verified by an input round-trip — they get a fire-and-confirm step.
   * Optional so existing callers/tests default to inputs.
   */
  isOutput?: boolean
}

/** Optional live context the runner bakes into certain steps (network loop). */
export interface BuildStepsContext {
  /** Live DLR ring verdict for the Network Loop auto-verify assist. */
  ringVerdict?: 'healthy' | 'degraded' | 'unknown' | null
  /** All networked DPMs communicating (null = unknown, never auto-pass). */
  dpmsCommunicating?: boolean | null
}

/**
 * Build the ordered list of Steps for a Task. One Step is delivered to the
 * tester at a time in guided mode; a Task isn't complete until all Steps pass.
 *
 * Step 1 of any device-targeted task is always a `navigate` step (the
 * mini-map + "I'm There"), mirroring the spec's "Example first Step for an IO
 * Check Task". The remaining steps depend on the task type.
 *
 * @param task  the task to expand
 * @param ios   the device's IO rows (for io-check tasks); ignored otherwise
 */
export function buildSteps(task: Task, ios: StepIo[] = [], ctx: BuildStepsContext = {}): Step[] {
  const steps: Step[] = []
  const dev = task.deviceName

  switch (task.type) {
    case 'io_check_safety':
    case 'io_check_nonsafety': {
      if (dev) {
        steps.push({
          id: `${task.id}:nav`,
          kind: 'navigate',
          title: 'STEP 1: GO HERE',
          instruction: `Navigate to ${dev}. Tap "I'm There" when you reach it.`,
          deviceName: dev,
        })
      }
      // One step per *untested* IO. Already-tested IOs are skipped so
      // re-entering a half-finished task resumes where the tester left off.
      const pending = ios.filter((io) => io.result == null)
      const list = pending.length > 0 ? pending : ios
      for (const io of list) {
        const label = shortLabel(io, dev)
        if (io.isOutput) {
          // OUTPUTS (beacons, horns, solenoids) can't be checked by an input
          // round-trip. Fire them and visually confirm, then pass/fail via the
          // acknowledgment popup. The runner's "Fire" button POSTs to
          // /api/ios/:id/fire-output for `fireOutputIoId`.
          steps.push({
            id: `${task.id}:io:${io.id}`,
            kind: 'manual_confirm',
            title: `STEP ${steps.length + 1}: FIRE ${label}`,
            instruction: `Fire ${label} and confirm it activates (look/listen for the beacon, horn or solenoid). Use "Fire" to drive the output, watch it, then mark Pass or Fail.`,
            deviceName: dev,
            ioId: io.id,
            ioName: io.name,
            isOutput: true,
            fireOutputIoId: io.id,
          })
          continue
        }
        // INPUTS: D6 full round-trip required — actuate AND return to rest.
        const circuit = classifyIoCircuit(io.name, io.description)
        const cls = classifyIoDeviceClass(io.name, io.description)
        const proc = deviceProcedure(cls, circuit)
        steps.push({
          id: `${task.id}:io:${io.id}`,
          kind: 'io_check',
          title: `STEP ${steps.length + 1}: CHECK ${label}`,
          instruction: `${proc.full} (${label}) through its full sequence. The tool watches the PLC and passes once both transitions are seen. If nothing happens, use "Nothing Happened".`,
          deviceName: dev,
          ioId: io.id,
          ioName: io.name,
          circuit,
          watchIoIds: [io.id],
        })
      }
      break
    }

    case 'estop_verification': {
      // Steps for an e-stop zone mirror the spec's worked example:
      //   Reset EPCs → make zone nominal → walk to each EPC → verify drop.
      steps.push({
        id: `${task.id}:reset`,
        kind: 'manual_confirm',
        title: 'STEP 1: MAKE ZONE NOMINAL',
        instruction:
          'Reset every EPC in this zone and confirm the zone is nominal (all conveyors able to run). Tap Continue when ready.',
      })
      steps.push({
        id: `${task.id}:verify`,
        kind: 'auto_detect',
        title: 'STEP 2: PULL EACH CORD',
        instruction:
          'Walk to each EPC and pull the cord. The tool watches the VFD safe-torque-off signals and records pass/fail automatically.',
        deviceName: dev,
        verdictSource: '/api/estop/status',
      })
      break
    }

    case 'vfd_setup': {
      if (dev) {
        steps.push({
          id: `${task.id}:nav`,
          kind: 'navigate',
          title: 'STEP 1: GO TO VFD',
          instruction: `Navigate to ${dev}. Tap "I'm There" when you reach it.`,
          deviceName: dev,
        })
      }
      steps.push({
        id: `${task.id}:wizard`,
        kind: 'manual_confirm',
        title: 'STEP 2: RUN VFD SETUP',
        instruction:
          'Complete the VFD setup wizard (identity, HP, direction, belt tracking, speed, controls). Open the full VFD wizard to enter values, then mark this step done.',
        deviceName: dev,
      })
      break
    }

    case 'network_loop': {
      const ringVerdict = ctx.ringVerdict ?? null
      const dpmsCommunicating = ctx.dpmsCommunicating ?? null
      // Auto-verify assist: when the DLR ring reads 'healthy' AND every DPM is
      // communicating, surface the live verdict and let the runner auto-pass.
      // 'unknown'/null never blocks — the tester can always confirm manually.
      const autoOk = ringVerdict === 'healthy' && dpmsCommunicating === true
      const verdictLine =
        ringVerdict === 'healthy'
          ? autoOk
            ? 'Live check: ring HEALTHY and all DPMs communicating — you may auto-pass.'
            : 'Live check: ring HEALTHY (DPM comms not yet confirmed).'
          : ringVerdict === 'degraded'
            ? 'Live check: ring FAULTED — resolve the ring before passing.'
            : 'Live ring status unknown (no DLR probe yet) — verify manually.'
      steps.push({
        id: `${task.id}:verify`,
        kind: 'manual_confirm',
        title: 'STEP 1: VERIFY NETWORK LOOP',
        instruction:
          `Confirm every DPM is communicating and the ring topology is healthy (no ring fault). ${verdictLine} Use the Network view for live link status, then mark this step done.`,
        ringVerdict,
        dpmsCommunicating,
      })
      break
    }

    case 'functional_check': {
      if (dev) {
        steps.push({
          id: `${task.id}:nav`,
          kind: 'navigate',
          title: 'STEP 1: GO HERE',
          instruction: `Navigate to ${dev}. Tap "I'm There" when you reach it.`,
          deviceName: dev,
        })
      }
      steps.push({
        id: `${task.id}:run`,
        kind: 'manual_confirm',
        title: 'STEP 2: RUN FUNCTIONAL CHECK',
        instruction:
          'With the system started and conveyors running, perform the functional check and record each column in the validation view, then mark this step done.',
        deviceName: dev,
      })
      break
    }
  }

  return steps
}

/** A VFD wizard column to record inline. */
export interface VfdColumn {
  name: string
  inputType: 'pass_fail' | 'number' | 'text'
  value: string | null
}

/**
 * VFD Setup, presented one wizard step at a time (Guided Mode spec: "all the
 * steps in the VFD setup wizard ... presented in this mode, one step at a
 * time"). Navigate → each commissioning column → Controls Verified.
 */
export function buildVfdSteps(task: Task, columns: VfdColumn[]): Step[] {
  const steps: Step[] = []
  const dev = task.deviceName
  if (dev) {
    steps.push({
      id: `${task.id}:nav`,
      kind: 'navigate',
      title: 'STEP 1: GO TO VFD',
      instruction: `Navigate to ${dev}. Tap "I'm There" when you reach it.`,
      deviceName: dev,
    })
  }
  for (const c of columns) {
    steps.push({
      id: `${task.id}:col:${c.name}`,
      kind: 'manual_confirm',
      title: `STEP ${steps.length + 1}: ${c.name.toUpperCase()}`,
      instruction: vfdHint(c.name),
      deviceName: dev,
      l2Column: c.name,
      inputType: c.inputType,
      currentValue: c.value,
    })
  }
  steps.push({
    id: `${task.id}:controls`,
    kind: 'manual_confirm',
    title: `STEP ${steps.length + 1}: CONTROLS VERIFIED`,
    instruction:
      'Confirm keypad controls (F0/F1/F2) operate the drive correctly, then mark verified.',
    deviceName: dev,
    vfdControls: true,
  })
  return steps
}

function vfdHint(col: string): string {
  switch (col) {
    case 'Verify Identity':
      return 'Confirm the drive on the keypad matches this device (name/address). Mark pass when verified.'
    case 'Motor HP (Field)':
      return 'Read the motor nameplate HP and enter it.'
    case 'VFD HP (Field)':
      return 'Read the VFD nameplate HP and enter it.'
    case 'Check Direction':
      return 'Bump the drive and confirm rotation/belt travel direction is correct.'
    case 'Polarity':
      return 'Set encoder/feedback polarity (Normal or Inverter).'
    case 'Belt Tracked':
      return 'Run the belt and confirm it tracks centered with no walk-off.'
    case 'Speed Set Up':
      return 'Calibrate the speed (FPM / RVS) and confirm setpoint.'
    default:
      return `Record "${col}".`
  }
}

/** A functional-check column to record inline (with cell ids for the write). */
export interface FunctionalColumn {
  columnId: number
  name: string
  inputType: 'pass_fail' | 'number' | 'text'
  value: string | null
}

/**
 * Functional check (SS / TPE / JPE / FPE / ENC / EPC), one column at a time.
 *
 * Committee decision D1 (Option D): functional checks are PURE prompt &
 * response — no automatic detection. The point of a functional check is a
 * human holistically verifying the physical install (PE / beacon / JR placed
 * sensibly) and catching upstream-process misses (miscolored buttons,
 * unconfigured PEs); a PLC transition can't judge either. The tester performs
 * the check and records the result; it writes to the same L2 cell as the
 * main tool.
 */
export function buildFunctionalSteps(
  task: Task,
  deviceId: number,
  columns: FunctionalColumn[],
): Step[] {
  const steps: Step[] = []
  const dev = task.deviceName
  if (dev) {
    steps.push({
      id: `${task.id}:nav`,
      kind: 'navigate',
      title: 'STEP 1: GO HERE',
      instruction: `Navigate to ${dev}. Tap "I'm There" when you reach it.`,
      deviceName: dev,
    })
  }
  for (const c of columns) {
    steps.push({
      id: `${task.id}:fcol:${c.columnId}`,
      kind: 'manual_confirm', // pure prompt & response (D1) — recorded to the L2 cell
      title: `STEP ${steps.length + 1}: ${c.name.toUpperCase()}`,
      instruction: `With the system started and running, perform: ${c.name}. Verify the response and the physical install yourself, then record the result.`,
      deviceName: dev,
      l2DeviceId: deviceId,
      l2ColumnId: c.columnId,
      l2Column: c.name,
      inputType: c.inputType,
      currentValue: c.value,
    })
  }
  return steps
}

/** A single EPC (pull cord) within a zone. */
export interface EstopEpcStep {
  name: string
  checkTag: string
  result: 'pass' | 'fail' | null
}

/**
 * E-Stop Verification, walked one EPC at a time (Guided Mode spec example:
 * make the zone nominal, then walk to each EPC, pull the cord, verify the
 * drop). Each EPC step polls the live auto-verdict and records pass/fail.
 */
export function buildEstopSteps(task: Task, zoneName: string, epcs: EstopEpcStep[]): Step[] {
  const steps: Step[] = []
  steps.push({
    id: `${task.id}:reset`,
    kind: 'manual_confirm',
    title: 'STEP 1: MAKE ZONE NOMINAL',
    instruction:
      'Reset every EPC in this zone and confirm the zone is nominal (all conveyors able to run). Tap Continue when ready.',
  })
  const pending = epcs.filter((e) => e.result == null)
  const list = pending.length > 0 ? pending : epcs
  for (const e of list) {
    // KK's worked example: "Zone nominal, walk to EPC1 (I'm There)" → verify →
    // "walk to EPC2 (I'm There)" → verify. Each EPC gets an explicit navigate
    // step carrying its deviceName so the map zooms to it, then the
    // auto-detect verify step.
    steps.push({
      id: `${task.id}:nav:${e.checkTag}`,
      kind: 'navigate',
      title: `STEP ${steps.length + 1}: WALK TO ${e.name.toUpperCase()}`,
      instruction: `Zone nominal — walk to ${e.name}. Tap "I'm There" when you reach it.`,
      deviceName: e.name,
      estopZone: zoneName,
      estopCheckTag: e.checkTag,
      estopEpcName: e.name,
    })
    steps.push({
      id: `${task.id}:epc:${e.checkTag}`,
      kind: 'auto_detect',
      title: `STEP ${steps.length + 1}: PULL ${e.name.toUpperCase()}`,
      instruction: `Pull the cord at ${e.name}. The tool watches the safe-torque-off signals and shows the verdict; confirm to record it.`,
      deviceName: e.name,
      estopZone: zoneName,
      estopCheckTag: e.checkTag,
      estopEpcName: e.name,
      verdictSource: '/api/estop/status',
      verdictKey: e.checkTag,
    })
  }
  return steps
}

function shortLabel(io: StepIo, device?: string): string {
  // Prefer a human description; fall back to the tag minus the device prefix.
  if (io.description && io.description.trim()) return io.description.trim()
  if (device && io.name.startsWith(device)) {
    const rest = io.name.slice(device.length).replace(/^[:._]/, '')
    return rest || io.name
  }
  return io.name
}
