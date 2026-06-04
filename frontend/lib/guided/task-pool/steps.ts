import type { Step, Task } from './types'

/**
 * Minimal IO shape the step-builder needs. Matches the `IoSummary` returned by
 * GET /api/guided/devices/:name, but kept local so this stays pure + testable.
 */
export interface StepIo {
  id: number
  name: string
  description: string | null
  result: 'Passed' | 'Failed' | null
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
export function buildSteps(task: Task, ios: StepIo[] = []): Step[] {
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
      // One io_check step per *untested* IO. Already-tested IOs are skipped so
      // re-entering a half-finished task resumes where the tester left off.
      const pending = ios.filter((io) => io.result == null)
      const list = pending.length > 0 ? pending : ios
      for (const io of list) {
        steps.push({
          id: `${task.id}:io:${io.id}`,
          kind: 'io_check',
          title: `STEP ${steps.length + 1}: CHECK ${shortLabel(io, dev)}`,
          instruction: `Actuate ${shortLabel(io, dev)} (e.g. block the photoeye / press the button). The tool watches the PLC and flags pass automatically. If nothing happens, use "Nothing Happened".`,
          deviceName: dev,
          ioId: io.id,
          ioName: io.name,
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
      steps.push({
        id: `${task.id}:verify`,
        kind: 'manual_confirm',
        title: 'STEP 1: VERIFY NETWORK LOOP',
        instruction:
          'Confirm every DPM is communicating and the ring topology is healthy (no ring fault). Use the Network view for live link status, then mark this step done.',
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
 * With the system running, the tester performs each check; the device's live
 * PLC input IOs are watched so a detected actuation can auto-assist a pass.
 */
export function buildFunctionalSteps(
  task: Task,
  deviceId: number,
  columns: FunctionalColumn[],
  watchIoIds: number[],
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
      kind: 'manual_confirm', // recorded as a cell; live-signal + auto-assist via watchIoIds
      title: `STEP ${steps.length + 1}: ${c.name.toUpperCase()}`,
      instruction: `With the system started and running, perform: ${c.name}. The tool shows the live PLC signal; pass auto-records on a detected response, or record it manually.`,
      deviceName: dev,
      l2DeviceId: deviceId,
      l2ColumnId: c.columnId,
      l2Column: c.name,
      inputType: c.inputType,
      currentValue: c.value,
      watchIoIds,
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
    steps.push({
      id: `${task.id}:epc:${e.checkTag}`,
      kind: 'auto_detect',
      title: `STEP ${steps.length + 1}: PULL ${e.name.toUpperCase()}`,
      instruction: `Walk to ${e.name} and pull the cord. The tool watches the safe-torque-off signals and shows the verdict; confirm to record it.`,
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
