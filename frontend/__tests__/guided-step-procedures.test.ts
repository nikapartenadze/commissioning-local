import { describe, expect, it } from 'vitest'
import {
  classifyIoDeviceClass,
  deviceProcedure,
} from '@/lib/guided/io-check-sequence'
import {
  buildSteps,
  buildEstopSteps,
  buildFunctionalSteps,
  type StepIo,
} from '@/lib/guided/task-pool/steps'
import { taskId } from '@/lib/guided/task-pool/task-builder'
import type { Step, Task } from '@/lib/guided/task-pool/types'

/**
 * Device-specific IO-check procedures, output fire-and-confirm steps, per-EPC
 * e-stop navigate steps, and the network-loop auto-verify assist. Also guards
 * committee decision D1 (functional checks stay PURE manual, no auto-detect).
 */

// ── helpers ──────────────────────────────────────────────────────────────────

function ioTask(device = 'PE1'): Task {
  return {
    id: taskId('io_check_nonsafety', device),
    type: 'io_check_nonsafety',
    phase: 'Commissioning',
    segment: 'Non-Safety Device I/O Check',
    priority: 5,
    title: `IO Check ${device}`,
    deviceName: device,
    state: 'available',
    steps: [],
    unmetDependencies: [],
    progress: 0,
  }
}

const io = (extra: Partial<StepIo>): StepIo => ({
  id: extra.id ?? 1,
  name: extra.name ?? 'DEV:I.In_0',
  description: extra.description ?? null,
  result: extra.result ?? null,
  isOutput: extra.isOutput,
})

const ioCheckSteps = (steps: Step[]) => steps.filter((s) => s.kind === 'io_check')

// ── device-class classification ───────────────────────────────────────────────

describe('classifyIoDeviceClass', () => {
  it('classifies photoeyes (PE/TPE/JPE/FPE)', () => {
    expect(classifyIoDeviceClass('PS8_10_CH4_PE1', null)).toBe('photoeye')
    expect(classifyIoDeviceClass('PS8_10_CH4_TPE2', null)).toBe('photoeye')
    expect(classifyIoDeviceClass('PS8_10_CH4_JPE1', 'JAM PHOTOEYE')).toBe('photoeye')
    expect(classifyIoDeviceClass('X', 'FULL PHOTO EYE')).toBe('photoeye')
  })

  it('classifies EPC pull cords', () => {
    expect(classifyIoDeviceClass('UL17_EPC1', null)).toBe('pull_cord')
    expect(classifyIoDeviceClass('X', 'E-STOP PULL CORD')).toBe('pull_cord')
  })

  it('classifies jam-reset / pushbuttons', () => {
    expect(classifyIoDeviceClass('PS8_10_CH4_JR1', 'JAM RESET PUSHBUTTON')).toBe('pushbutton')
    expect(classifyIoDeviceClass('PS8_10_CH4_PB2', null)).toBe('pushbutton')
  })

  it('classifies OEM interlocks / doors / gates', () => {
    expect(classifyIoDeviceClass('OEM1_INTERLOCK', null)).toBe('interlock')
    expect(classifyIoDeviceClass('X', 'GUARD DOOR SWITCH')).toBe('interlock')
  })

  it('falls back to generic for unknown discretes', () => {
    expect(classifyIoDeviceClass('DEV:I.In_3', null)).toBe('generic')
  })
})

describe('deviceProcedure — field-correct wording per class', () => {
  it('photoeye → block then clear', () => {
    expect(deviceProcedure('photoeye', 'NC').full).toBe('Block the photoeye, then clear it')
  })
  it('pull_cord → pull then reset', () => {
    expect(deviceProcedure('pull_cord', 'NC').full).toBe('Pull the cord, then reset it')
  })
  it('pushbutton → press then release', () => {
    expect(deviceProcedure('pushbutton', 'NO').full).toBe('Press the button, then release it')
  })
  it('interlock → open then close', () => {
    expect(deviceProcedure('interlock', 'NC').full).toMatch(/open .*then close/i)
  })
  it('generic falls back to circuit-typed wording', () => {
    expect(deviceProcedure('generic', 'NC').full).toMatch(/block .*then clear \/ reset/i)
    expect(deviceProcedure('generic', 'NO').full).toMatch(/press .*then release/i)
  })
})

// ── device-specific instructions in built steps ───────────────────────────────

describe('buildSteps — device-specific IO-check instructions', () => {
  it('photoeye step instructs block-then-clear (not generic actuate/release)', () => {
    const steps = buildSteps(ioTask(), [io({ id: 1, name: 'PS8_10_CH4_PE1', description: 'PHOTOEYE' })])
    const check = ioCheckSteps(steps)[0]
    expect(check.circuit).toBe('NC')
    expect(check.instruction).toMatch(/block the photoeye, then clear it/i)
    expect(check.instruction).not.toMatch(/actuate \/ release/i)
  })

  it('EPC step instructs pull-then-reset', () => {
    const steps = buildSteps(ioTask('UL17'), [io({ id: 2, name: 'UL17_EPC1', description: 'EPC PULL CORD' })])
    expect(ioCheckSteps(steps)[0].instruction).toMatch(/pull the cord, then reset it/i)
  })

  it('jam-reset / pushbutton step instructs press-then-release', () => {
    const steps = buildSteps(ioTask(), [io({ id: 3, name: 'PS8_10_CH4_JR1', description: 'JAM RESET PB' })])
    const check = ioCheckSteps(steps)[0]
    expect(check.circuit).toBe('NO')
    expect(check.instruction).toMatch(/press the button, then release it/i)
  })

  it('interlock / door step has sensible open-then-close wording', () => {
    const steps = buildSteps(ioTask('OEM1'), [io({ id: 4, name: 'OEM1_DOOR', description: 'GUARD DOOR' })])
    expect(ioCheckSteps(steps)[0].instruction).toMatch(/open .*then close/i)
  })

  it('still watches the IO + keeps the full-sequence auto-pass detection intact', () => {
    const steps = buildSteps(ioTask(), [io({ id: 9, name: 'PS8_10_CH4_PE1', description: 'PHOTOEYE' })])
    const check = ioCheckSteps(steps)[0]
    expect(check.kind).toBe('io_check')
    expect(check.watchIoIds).toEqual([9])
    expect(check.instruction).toMatch(/full sequence/i)
  })
})

// ── outputs: fire-and-confirm ──────────────────────────────────────────────────

describe('buildSteps — outputs get a checkable fire-and-confirm step', () => {
  it('beacon output produces a manual_confirm "Fire … and confirm" step (not io_check)', () => {
    const steps = buildSteps(ioTask('PS8_10_CH4_BCN1'), [
      io({ id: 5, name: 'PS8_10_CH4_BCN1:O.Green', description: 'GREEN BEACON', isOutput: true }),
    ])
    const out = steps.find((s) => s.isOutput)
    expect(out).toBeDefined()
    expect(out!.kind).toBe('manual_confirm')
    expect(out!.fireOutputIoId).toBe(5)
    expect(out!.instruction).toMatch(/fire .*confirm it activates/i)
    // outputs are NOT auto-detected via the input round-trip
    expect(out!.kind).not.toBe('io_check')
    expect(out!.watchIoIds).toBeUndefined()
  })

  it('mixes input round-trip + output fire steps in one device', () => {
    const steps = buildSteps(ioTask('PS8_10_CH4'), [
      io({ id: 6, name: 'PS8_10_CH4_PE1', description: 'PHOTOEYE' }),
      io({ id: 7, name: 'PS8_10_CH4_BCN1:O.Green', description: 'GREEN BEACON', isOutput: true }),
    ])
    expect(ioCheckSteps(steps)).toHaveLength(1) // PE only
    expect(steps.filter((s) => s.isOutput)).toHaveLength(1) // beacon only
  })
})

// ── e-stop: per-EPC navigate steps ─────────────────────────────────────────────

describe('buildEstopSteps — per-EPC walk-to navigate steps (KK example)', () => {
  const estop: Task = {
    id: taskId('estop_verification', 'Zone 1'),
    type: 'estop_verification',
    phase: 'Commissioning',
    segment: 'Safety Verification',
    priority: 4,
    title: 'E-Stop Verification: Zone 1',
    state: 'available',
    steps: [],
    unmetDependencies: [],
    progress: 0,
  }

  it('reset → (navigate EPC1 → verify EPC1) → (navigate EPC2 → verify EPC2)', () => {
    const steps = buildEstopSteps(estop, 'Zone 1', [
      { name: 'EPC1', checkTag: 'T1', result: null },
      { name: 'EPC2', checkTag: 'T2', result: null },
    ])
    expect(steps[0].kind).toBe('manual_confirm') // make zone nominal

    const navs = steps.filter((s) => s.kind === 'navigate')
    const verifies = steps.filter((s) => s.kind === 'auto_detect')
    expect(navs).toHaveLength(2)
    expect(verifies).toHaveLength(2)

    // each navigate carries the EPC's deviceName so the map zooms to it
    expect(navs[0].deviceName).toBe('EPC1')
    expect(navs[0].instruction).toMatch(/walk to EPC1/i)
    expect(navs[0].instruction).toMatch(/i'm there/i)
    expect(navs[1].deviceName).toBe('EPC2')

    // navigate precedes its EPC's verify step, ordering preserved
    const order = steps.map((s) => s.kind)
    expect(order).toEqual(['manual_confirm', 'navigate', 'auto_detect', 'navigate', 'auto_detect'])

    // the existing auto-verdict polling is kept
    expect(verifies[0].verdictSource).toBe('/api/estop/status')
    expect(verifies[0].verdictKey).toBe('T1')
  })

  it('only pending EPCs get steps (resume a half-finished zone)', () => {
    const steps = buildEstopSteps(estop, 'Zone 1', [
      { name: 'EPC1', checkTag: 'T1', result: 'pass' },
      { name: 'EPC2', checkTag: 'T2', result: null },
    ])
    expect(steps.filter((s) => s.kind === 'auto_detect')).toHaveLength(1)
    expect(steps.filter((s) => s.kind === 'navigate')).toHaveLength(1)
    expect(steps.find((s) => s.kind === 'navigate')!.deviceName).toBe('EPC2')
  })
})

// ── network loop: auto-verify assist ───────────────────────────────────────────

describe('buildSteps — network-loop auto-verify assist', () => {
  const netTask: Task = {
    id: taskId('network_loop', '1'),
    type: 'network_loop',
    phase: 'Commissioning',
    segment: 'Network Verification',
    priority: 1,
    title: 'Verify Network Loop',
    state: 'available',
    steps: [],
    unmetDependencies: [],
    progress: 0,
  }

  it('surfaces an auto-pass-able verdict when ring healthy AND DPMs communicating', () => {
    const steps = buildSteps(netTask, [], { ringVerdict: 'healthy', dpmsCommunicating: true })
    expect(steps[0].kind).toBe('manual_confirm') // manual confirm still allowed
    expect(steps[0].ringVerdict).toBe('healthy')
    expect(steps[0].dpmsCommunicating).toBe(true)
    expect(steps[0].instruction).toMatch(/auto-pass/i)
  })

  it('does NOT offer auto-pass on unknown ring (never blocks, manual only)', () => {
    const steps = buildSteps(netTask, [], { ringVerdict: 'unknown', dpmsCommunicating: null })
    expect(steps[0].ringVerdict).toBe('unknown')
    expect(steps[0].instruction).not.toMatch(/auto-pass/i)
    // still a confirmable manual step — never blocked on unknown
    expect(steps[0].kind).toBe('manual_confirm')
  })

  it('flags a faulted ring rather than auto-passing', () => {
    const steps = buildSteps(netTask, [], { ringVerdict: 'degraded', dpmsCommunicating: false })
    expect(steps[0].instruction).toMatch(/faulted/i)
    expect(steps[0].instruction).not.toMatch(/auto-pass/i)
  })

  it('healthy ring but DPM comms unknown does not auto-pass yet', () => {
    const steps = buildSteps(netTask, [], { ringVerdict: 'healthy', dpmsCommunicating: null })
    expect(steps[0].instruction).not.toMatch(/auto-pass/i)
  })
})

// ── D1 guard: functional checks stay PURE manual ────────────────────────────────

describe('D1 — functional checks remain pure prompt & response (no auto)', () => {
  const fn: Task = {
    id: taskId('functional_check', 'SS:SS1'),
    type: 'functional_check',
    phase: 'Commissioning',
    segment: 'Functional Validation',
    priority: 6,
    title: 'Start/Stop Check: SS1',
    deviceName: 'SS1',
    state: 'available',
    steps: [],
    unmetDependencies: [],
    progress: 0,
  }

  it('functional steps are manual_confirm, never io_check/auto_detect, no watch, no auto wording', () => {
    const steps = buildFunctionalSteps(fn, 42, [
      { columnId: 10, name: 'Motor Runs', inputType: 'pass_fail', value: null },
      { columnId: 11, name: 'Motor Stops', inputType: 'pass_fail', value: null },
    ])
    const cols = steps.filter((s) => s.l2ColumnId != null)
    expect(cols).toHaveLength(2)
    for (const c of cols) {
      expect(c.kind).toBe('manual_confirm')
      expect(c.watchIoIds).toBeUndefined()
      expect(c.isOutput).toBeUndefined()
      expect(c.instruction).not.toMatch(/auto/i)
    }
  })
})
