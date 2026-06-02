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

function shortLabel(io: StepIo, device?: string): string {
  // Prefer a human description; fall back to the tag minus the device prefix.
  if (io.description && io.description.trim()) return io.description.trim()
  if (device && io.name.startsWith(device)) {
    const rest = io.name.slice(device.length).replace(/^[:._]/, '')
    return rest || io.name
  }
  return io.name
}
