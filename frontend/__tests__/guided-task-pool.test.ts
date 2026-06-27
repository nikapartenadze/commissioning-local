import { describe, expect, it } from 'vitest'
import { buildTaskPool, taskId } from '@/lib/guided/task-pool/task-builder'
import { pickNextTask, TASK_PRIORITY } from '@/lib/guided/task-pool/priority'
import { buildSteps, buildVfdSteps, buildFunctionalSteps, buildEstopSteps } from '@/lib/guided/task-pool/steps'
import type {
  DataSnapshot,
  SnapshotDevice,
  SnapshotIo,
} from '@/lib/guided/task-pool/snapshot-types'
import type { Task, TaskType } from '@/lib/guided/task-pool/types'

// ── helpers ────────────────────────────────────────────────────────────────

function io(
  id: number,
  result: SnapshotIo['result'],
  safety = false,
  extra: Partial<Pick<SnapshotIo, 'name' | 'description' | 'circuit' | 'liveState'>> = {},
): SnapshotIo {
  return {
    id,
    name: extra.name ?? `DEV:I.In_${id}`,
    description: extra.description ?? `IO ${id}`,
    result,
    tagType: null,
    isOutput: false,
    isSafety: safety,
    circuit: extra.circuit ?? 'NO',
    liveState: extra.liveState ?? null,
  }
}

function device(
  name: string,
  order: number,
  ios: SnapshotIo[],
  opts: Partial<Pick<SnapshotDevice, 'isSafety' | 'installComplete' | 'networked'>> = {},
): SnapshotDevice {
  return {
    deviceName: name,
    order,
    ios,
    isSafety: opts.isSafety ?? ios.some((i) => i.isSafety),
    installComplete: opts.installComplete ?? null,
    networked: opts.networked ?? null,
  }
}

function emptySnapshot(overrides: Partial<DataSnapshot> = {}): DataSnapshot {
  return {
    subsystemId: 1,
    mcm: 'MCM09',
    mapSource: 'mcm-diagram',
    plcConnected: true,
    ioCount: 0,
    devices: [],
    estopZones: [],
    vfds: [],
    functional: [],
    network: { hasRings: false, dpmsAllInstalled: null },
    beltsTracked: null,
    allNetworkedCommunicating: null,
    systemRunning: null,
    ringHealth: null,
    manualTaskStatus: {},
    ...overrides,
  }
}

const byId = (tasks: Task[], id: string) => tasks.find((t) => t.id === id)

// ── firmware compliance gate ─────────────────────────────────────────────────
describe('firmware_check task', () => {
  const fw = { scanned: true, deviceCount: 5, nonCompliantCount: 1, noBaselineCount: 0 }

  it('is NOT generated when the snapshot carries no firmware summary', () => {
    const pool = buildTaskPool(emptySnapshot())
    expect(pool.tasks.find((t) => t.type === 'firmware_check')).toBeUndefined()
  })

  it('is generated (available, own segment) when a firmware summary is present', () => {
    const pool = buildTaskPool(emptySnapshot({ firmware: fw }))
    const t = byId(pool.tasks, taskId('firmware_check', '1'))
    expect(t?.state).toBe('available')
    expect(t?.segment).toBe('Firmware Compliance')
  })

  it('is handed first — priority 1, id tie-break beats the network loop', () => {
    const pool = buildTaskPool(
      emptySnapshot({ firmware: fw, network: { hasRings: true, dpmsAllInstalled: null } }),
    )
    expect(pool.nextTaskId).toBe(taskId('firmware_check', '1'))
  })

  it('completes via manual status (manual gate, like the network loop)', () => {
    const id = taskId('firmware_check', '1')
    const pool = buildTaskPool(
      emptySnapshot({ firmware: fw, manualTaskStatus: { [id]: { status: 'completed' } } }),
    )
    expect(byId(pool.tasks, id)?.state).toBe('completed')
  })

  it('builds an info scan step then an auto_detect verdict confirm step', () => {
    const pool = buildTaskPool(emptySnapshot({ firmware: fw }))
    const task = byId(pool.tasks, taskId('firmware_check', '1'))!
    const steps = buildSteps(task)
    expect(steps.map((s) => s.kind)).toEqual(['info', 'auto_detect'])
    expect(steps[1].verdictSource).toBe('/api/firmware')
  })
})

// ── priority ────────────────────────────────────────────────────────────────

describe('TASK_PRIORITY', () => {
  it('follows the commissioning flow order', () => {
    const order: TaskType[] = [
      'network_loop',
      'io_check_safety',
      'estop_verification',
      'io_check_nonsafety',
      'vfd_setup',
      'functional_check',
    ]
    const ranks = order.map((t) => TASK_PRIORITY[t])
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('pickNextTask', () => {
  const mk = (id: string, type: TaskType, state: Task['state']): Task => ({
    id,
    type,
    phase: 'Commissioning',
    segment: 'Network Verification',
    priority: TASK_PRIORITY[type],
    title: id,
    state,
    steps: [],
    unmetDependencies: [],
    progress: 0,
  })

  it('returns the highest-priority available task', () => {
    const tasks = [
      mk('a', 'functional_check', 'available'),
      mk('b', 'io_check_safety', 'available'),
      mk('c', 'io_check_nonsafety', 'available'),
    ]
    expect(pickNextTask(tasks)?.id).toBe('b')
  })

  it('ignores blocked, completed and skipped tasks', () => {
    const tasks = [
      mk('a', 'network_loop', 'blocked'),
      mk('b', 'vfd_setup', 'completed'),
      mk('c', 'io_check_safety', 'skipped'),
      mk('d', 'io_check_nonsafety', 'available'),
    ]
    expect(pickNextTask(tasks)?.id).toBe('d')
  })

  it('prefers in_progress over available at the same priority', () => {
    const a = mk('io_check_safety:A', 'io_check_safety', 'available')
    const b = mk('io_check_safety:B', 'io_check_safety', 'in_progress')
    expect(pickNextTask([a, b])?.id).toBe('io_check_safety:B')
  })

  it('returns null when nothing is workable', () => {
    expect(pickNextTask([mk('a', 'network_loop', 'blocked')])).toBeNull()
  })
})

// ── builder: empty ───────────────────────────────────────────────────────────

describe('buildTaskPool — empty subsystem', () => {
  it('produces no tasks and a null next', () => {
    const pool = buildTaskPool(emptySnapshot())
    expect(pool.tasks).toHaveLength(0)
    expect(pool.nextTaskId).toBeNull()
    expect(pool.summary.total).toBe(0)
  })
})

// ── builder: io check tasks ──────────────────────────────────────────────────

describe('buildTaskPool — IO check tasks', () => {
  it('creates one safety and one non-safety task, classified correctly', () => {
    const snap = emptySnapshot({
      devices: [
        device('SAFE1', 0, [io(1, null, true)], { isSafety: true }),
        device('PE1', 1, [io(2, null, false)], { isSafety: false }),
      ],
    })
    const pool = buildTaskPool(snap)
    expect(byId(pool.tasks, taskId('io_check_safety', 'SAFE1'))?.title).toBe('IO Check SAFE1')
    expect(byId(pool.tasks, taskId('io_check_nonsafety', 'PE1'))?.title).toBe('IO Check PE1')
  })

  it('skips devices with no IOs', () => {
    const snap = emptySnapshot({ devices: [device('EMPTY', 0, [])] })
    expect(buildTaskPool(snap).tasks).toHaveLength(0)
  })

  it('marks an IO check available when no results yet', () => {
    const snap = emptySnapshot({ devices: [device('PE1', 0, [io(1, null)])] })
    expect(byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))?.state).toBe(
      'available',
    )
  })

  it('marks in_progress when some but not all IOs tested', () => {
    const snap = emptySnapshot({
      devices: [device('PE1', 0, [io(1, 'Passed'), io(2, null)])],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))
    expect(t?.state).toBe('in_progress')
    expect(t?.progress).toBeCloseTo(0.5)
  })

  it('marks completed when all IOs tested (pass or fail)', () => {
    const snap = emptySnapshot({
      devices: [device('PE1', 0, [io(1, 'Passed'), io(2, 'Failed')])],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))
    expect(t?.state).toBe('completed')
    expect(t?.progress).toBe(1)
  })

  it('blocks an IO check when the device is not 100% installed', () => {
    const snap = emptySnapshot({
      devices: [device('PE1', 0, [io(1, null)], { installComplete: false })],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies).toContain('PE1 must be 100% installed')
  })

  it('blocks an IO check when the device is not networked', () => {
    const snap = emptySnapshot({
      devices: [device('PE1', 0, [io(1, null)], { networked: false })],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies).toContain('PE1 must be networked and communicating')
  })

  it('does not block when install/network are unknown (null)', () => {
    const snap = emptySnapshot({ devices: [device('PE1', 0, [io(1, null)])] })
    expect(byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))?.state).toBe(
      'available',
    )
  })
})

// ── builder: network loop gating ─────────────────────────────────────────────

describe('buildTaskPool — network loop gating', () => {
  it('creates a network loop task when rings exist and gates VFD/IO behind it', () => {
    const snap = emptySnapshot({
      network: { hasRings: true, dpmsAllInstalled: null },
      vfds: [{ deviceName: 'VFD1', order: 0, steps: [{ name: 'Verify Identity', value: null }], controlsVerified: false }],
      devices: [device('PE1', 0, [io(1, null)])],
    })
    const pool = buildTaskPool(snap)
    expect(byId(pool.tasks, taskId('network_loop', '1'))?.state).toBe('available')
    // network not done → VFD + IO blocked behind it
    expect(byId(pool.tasks, taskId('vfd_setup', 'VFD1'))?.state).toBe('blocked')
    expect(byId(pool.tasks, taskId('io_check_nonsafety', 'PE1'))?.unmetDependencies).toContain(
      'All Network Loop tasks must be done',
    )
    // highest-priority workable is the network loop itself
    expect(pool.nextTaskId).toBe(taskId('network_loop', '1'))
  })

  it('unblocks downstream tasks once network loop is manually completed', () => {
    const snap = emptySnapshot({
      network: { hasRings: true, dpmsAllInstalled: null },
      devices: [device('PE1', 0, [io(1, null)])],
      manualTaskStatus: { [taskId('network_loop', '1')]: { status: 'completed' } },
    })
    const pool = buildTaskPool(snap)
    expect(byId(pool.tasks, taskId('network_loop', '1'))?.state).toBe('completed')
    expect(byId(pool.tasks, taskId('io_check_nonsafety', 'PE1'))?.state).toBe('available')
  })

  it('blocks the network loop when DPMs are not all installed', () => {
    const snap = emptySnapshot({ network: { hasRings: true, dpmsAllInstalled: false } })
    const t = byId(buildTaskPool(snap).tasks, taskId('network_loop', '1'))
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies).toContain('All DPMs must be marked 100% installed')
  })

  it('treats network loop as vacuously done when there are no rings', () => {
    const snap = emptySnapshot({ devices: [device('PE1', 0, [io(1, null)])] })
    expect(byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))?.state).toBe(
      'available',
    )
  })
})

// ── builder: e-stop verification gating ──────────────────────────────────────

describe('buildTaskPool — e-stop verification', () => {
  it('blocks e-stop verification until all safety IO checks are done', () => {
    const snap = emptySnapshot({
      devices: [device('SAFE1', 0, [io(1, null, true)], { isSafety: true })],
      estopZones: [{ zoneName: 'Zone 1', epcs: [{ name: 'EPC1', checkTag: 'T1', result: null, finalResult: null }], safetyDeviceNames: [] }],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('estop_verification', 'Zone 1'))
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies).toContain('All Safety I/O Check tasks must be done first')
  })

  it('makes e-stop verification available once safety IO checks complete', () => {
    const snap = emptySnapshot({
      devices: [device('SAFE1', 0, [io(1, 'Passed', true)], { isSafety: true })],
      estopZones: [{ zoneName: 'Zone 1', epcs: [{ name: 'EPC1', checkTag: 'T1', result: null, finalResult: null }], safetyDeviceNames: [] }],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('estop_verification', 'Zone 1'))
    expect(t?.state).toBe('available')
  })

  it('gates a zone on ONLY its own devices when mapped (per-zone dependency)', () => {
    // Zone A maps to SAFE_A (passed); Zone B maps to SAFE_B (untested).
    const snap = emptySnapshot({
      devices: [
        device('SAFE_A', 0, [io(1, 'Passed', true)], { isSafety: true }),
        device('SAFE_B', 1, [io(2, null, true)], { isSafety: true }),
      ],
      estopZones: [
        { zoneName: 'Zone A', epcs: [{ name: 'EPC_A', checkTag: 'TA', result: null, finalResult: null }], safetyDeviceNames: ['SAFE_A'] },
        { zoneName: 'Zone B', epcs: [{ name: 'EPC_B', checkTag: 'TB', result: null, finalResult: null }], safetyDeviceNames: ['SAFE_B'] },
      ],
    })
    const pool = buildTaskPool(snap)
    // Zone A is available even though SAFE_B (a different zone's device) is untested.
    expect(byId(pool.tasks, taskId('estop_verification', 'Zone A'))?.state).toBe('available')
    // Zone B is blocked because its own device SAFE_B isn't checked.
    const zb = byId(pool.tasks, taskId('estop_verification', 'Zone B'))
    expect(zb?.state).toBe('blocked')
    expect(zb?.unmetDependencies.join(' ')).toContain('SAFE_B')
  })

  it('completes an e-stop zone only when every EPC has BOTH checks (dual-safety)', () => {
    const snap = emptySnapshot({
      estopZones: [
        {
          zoneName: 'Zone 1',
          epcs: [
            { name: 'EPC1', checkTag: 'T1', result: 'pass', finalResult: 'pass' },
            { name: 'EPC2', checkTag: 'T2', result: 'fail', finalResult: 'pass' },
          ],
          safetyDeviceNames: [],
        },
      ],
    })
    expect(byId(buildTaskPool(snap).tasks, taskId('estop_verification', 'Zone 1'))?.state).toBe(
      'completed',
    )
  })

  it('stays in_progress when an EPC has only the preliminary check (final missing)', () => {
    const snap = emptySnapshot({
      estopZones: [
        {
          zoneName: 'Zone 1',
          epcs: [{ name: 'EPC1', checkTag: 'T1', result: 'pass', finalResult: null }],
          safetyDeviceNames: [],
        },
      ],
    })
    expect(byId(buildTaskPool(snap).tasks, taskId('estop_verification', 'Zone 1'))?.state).toBe(
      'in_progress',
    )
  })
})

// ── builder: vfd + functional ────────────────────────────────────────────────

describe('buildTaskPool — VFD setup', () => {
  it('completes a VFD when all steps filled and controls verified', () => {
    const snap = emptySnapshot({
      vfds: [
        {
          deviceName: 'VFD1',
          order: 0,
          steps: [
            { name: 'Verify Identity', value: 'Pass' },
            { name: 'Speed Set Up', value: 'Pass' },
          ],
          controlsVerified: true,
        },
      ],
    })
    expect(byId(buildTaskPool(snap).tasks, taskId('vfd_setup', 'VFD1'))?.state).toBe('completed')
  })

  it('is in_progress when controls not yet verified', () => {
    const snap = emptySnapshot({
      vfds: [
        {
          deviceName: 'VFD1',
          order: 0,
          steps: [{ name: 'Verify Identity', value: 'Pass' }],
          controlsVerified: false,
        },
      ],
    })
    expect(byId(buildTaskPool(snap).tasks, taskId('vfd_setup', 'VFD1'))?.state).toBe('in_progress')
  })
})

describe('buildTaskPool — functional checks', () => {
  it('blocks functional checks when belts are not tracked', () => {
    const snap = emptySnapshot({
      beltsTracked: false,
      functional: [
        { sheetName: 'SS', displayName: 'Start/Stop', deviceName: 'SS1', order: 0, completedChecks: 0, totalChecks: 3 },
      ],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('functional_check', 'SS:SS1'))
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies).toContain('All belts must be tracked')
  })

  it('completes a functional check when all columns done', () => {
    const snap = emptySnapshot({
      functional: [
        { sheetName: 'SS', displayName: 'Start/Stop', deviceName: 'SS1', order: 0, completedChecks: 3, totalChecks: 3 },
      ],
    })
    expect(byId(buildTaskPool(snap).tasks, taskId('functional_check', 'SS:SS1'))?.state).toBe(
      'completed',
    )
  })
})

// ── builder: skip ────────────────────────────────────────────────────────────

describe('buildTaskPool — skip', () => {
  it('marks a task skipped with its reason and keeps it out of the next pick', () => {
    const id = taskId('io_check_nonsafety', 'PE1')
    const snap = emptySnapshot({
      devices: [device('PE1', 0, [io(1, null)]), device('PE2', 1, [io(2, null)])],
      manualTaskStatus: { [id]: { status: 'skipped', reason: 'Device damaged' } },
    })
    const pool = buildTaskPool(snap)
    const t = byId(pool.tasks, id)
    expect(t?.state).toBe('skipped')
    expect(t?.skipReason).toBe('Device damaged')
    expect(pool.nextTaskId).toBe(taskId('io_check_nonsafety', 'PE2'))
  })
})

// ── full priority ordering integration ───────────────────────────────────────

describe('buildTaskPool — full priority ordering', () => {
  it('hands tasks back in commissioning-flow priority order', () => {
    const snap = emptySnapshot({
      network: { hasRings: false, dpmsAllInstalled: null },
      vfds: [{ deviceName: 'VFD1', order: 0, steps: [{ name: 'Verify Identity', value: null }], controlsVerified: false }],
      devices: [
        device('SAFE1', 0, [io(1, null, true)], { isSafety: true }),
        device('PE1', 1, [io(2, null, false)], { isSafety: false }),
      ],
      functional: [
        { sheetName: 'SS', displayName: 'Start/Stop', deviceName: 'SS1', order: 0, completedChecks: 0, totalChecks: 2 },
      ],
    })
    const pool = buildTaskPool(snap)
    // IO Check (Safety) is priority 2 (ahead of VFD now) and SAFE1 is workable
    // — there's no network ring to gate it and the safety IO is untested.
    expect(pool.nextTaskId).toBe(taskId('io_check_safety', 'SAFE1'))

    // Once VFD + safety done, next should be the non-safety IO check.
    const snap2 = emptySnapshot({
      ...snap,
      vfds: [{ deviceName: 'VFD1', order: 0, steps: [{ name: 'Verify Identity', value: 'Pass' }], controlsVerified: true }],
      devices: [
        device('SAFE1', 0, [io(1, 'Passed', true)], { isSafety: true }),
        device('PE1', 1, [io(2, null, false)], { isSafety: false }),
      ],
    })
    expect(buildTaskPool(snap2).nextTaskId).toBe(taskId('io_check_nonsafety', 'PE1'))
  })
})

// ── steps ────────────────────────────────────────────────────────────────────

describe('buildSteps', () => {
  const ioTask: Task = {
    id: taskId('io_check_nonsafety', 'PE1'),
    type: 'io_check_nonsafety',
    phase: 'Commissioning',
    segment: 'Non-Safety Device I/O Check',
    priority: 5,
    title: 'IO Check PE1',
    deviceName: 'PE1',
    state: 'available',
    steps: [],
    unmetDependencies: [],
    progress: 0,
  }

  it('starts an IO-check task with a navigate step then one io_check per untested IO', () => {
    const steps = buildSteps(ioTask, [
      { id: 1, name: 'PE1:I.Blocked', description: 'Photoeye blocked', result: null },
      { id: 2, name: 'PE1:I.Clear', description: 'Photoeye clear', result: null },
    ])
    expect(steps[0].kind).toBe('navigate')
    expect(steps[0].title).toBe('STEP 1: GO HERE')
    expect(steps[1].kind).toBe('io_check')
    expect(steps[1].ioId).toBe(1)
    expect(steps[2].ioId).toBe(2)
    expect(steps).toHaveLength(3)
  })

  it('skips already-tested IOs so a half-finished task resumes', () => {
    const steps = buildSteps(ioTask, [
      { id: 1, name: 'PE1:I.Blocked', description: 'blocked', result: 'Passed' },
      { id: 2, name: 'PE1:I.Clear', description: 'clear', result: null },
    ])
    const checks = steps.filter((s) => s.kind === 'io_check')
    expect(checks).toHaveLength(1)
    expect(checks[0].ioId).toBe(2)
  })

  it('builds reset + auto-detect steps for e-stop verification', () => {
    const estop: Task = { ...ioTask, id: taskId('estop_verification', 'Zone 1'), type: 'estop_verification', deviceName: undefined }
    const steps = buildSteps(estop)
    expect(steps[0].kind).toBe('manual_confirm')
    expect(steps[1].kind).toBe('auto_detect')
    expect(steps[1].verdictSource).toBe('/api/estop/status')
  })

  it('io_check steps carry watchIoIds for auto-detection', () => {
    const steps = buildSteps(ioTask, [{ id: 7, name: 'PE1:I.x', description: 'x', result: null }])
    const check = steps.find((s) => s.kind === 'io_check')
    expect(check?.watchIoIds).toEqual([7])
  })
})

describe('buildVfdSteps', () => {
  const vfd: Task = {
    id: taskId('vfd_setup', 'VFD1'),
    type: 'vfd_setup',
    phase: 'Commissioning',
    segment: 'VFD Commissioning',
    priority: 2,
    title: 'VFD Setup: VFD1',
    deviceName: 'VFD1',
    state: 'available',
    steps: [],
    unmetDependencies: [],
    progress: 0,
  }

  it('navigates, records each column, then controls-verified', () => {
    const steps = buildVfdSteps(vfd, [
      { name: 'Verify Identity', inputType: 'pass_fail', value: null },
      { name: 'Motor HP (Field)', inputType: 'number', value: null },
    ])
    expect(steps[0].kind).toBe('navigate')
    expect(steps[1].l2Column).toBe('Verify Identity')
    expect(steps[1].inputType).toBe('pass_fail')
    expect(steps[2].l2Column).toBe('Motor HP (Field)')
    expect(steps[2].inputType).toBe('number')
    expect(steps[steps.length - 1].vfdControls).toBe(true)
  })
})

describe('buildFunctionalSteps', () => {
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

  it('navigates then one pure prompt/response column step per column (D1: no watch)', () => {
    const steps = buildFunctionalSteps(fn, 42, [
      { columnId: 10, name: 'Motor Runs', inputType: 'pass_fail', value: null },
      { columnId: 11, name: 'Motor Stops', inputType: 'pass_fail', value: null },
    ])
    expect(steps[0].kind).toBe('navigate')
    expect(steps[1].kind).toBe('manual_confirm')
    expect(steps[1].l2DeviceId).toBe(42)
    expect(steps[1].l2ColumnId).toBe(10)
    // D1 (committee Option D): functional checks are prompt & response only —
    // no live-signal watch, no auto-assist.
    expect(steps[1].watchIoIds).toBeUndefined()
    expect(steps[1].instruction).not.toMatch(/auto/i)
    expect(steps).toHaveLength(3)
  })
})

// ── committee decisions (2026-06) ────────────────────────────────────────────

describe('D3 — associated-device gating for functional checks', () => {
  // PS8_10_CH4_JPE1 functional check gates on the JPE + beacon + JR IOs that
  // share the PS8_10_CH4 location prefix.
  const mkDevices = (bcnResult: SnapshotIo['result'], jrResult: SnapshotIo['result']) => [
    device('DPM1', 0, [
      io(1, bcnResult, false, { name: 'PS8_10_CH4_BCN1', description: 'PS8_10_CH4_BCN1 GREEN BEACON' }),
      io(2, jrResult, false, { name: 'PS8_10_CH4_JR1', description: 'PS8_10_CH4_JR1 JAM RESET PB' }),
      io(3, 'Passed', false, { name: 'PS9_99_CH1_BCN1', description: 'unrelated' }),
    ]),
  ]
  const functional = [
    { sheetName: 'JPE', displayName: 'Jam PE', deviceName: 'PS8_10_CH4_JPE1', order: 0, completedChecks: 0, totalChecks: 2 },
  ]
  const fid = taskId('functional_check', 'JPE:PS8_10_CH4_JPE1')

  it('blocks the functional task while associated IOs are unchecked', () => {
    const pool = buildTaskPool(emptySnapshot({ devices: mkDevices(null, null), functional }))
    const t = byId(pool.tasks, fid)
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies.join(' ')).toMatch(/Associated devices must pass IO check first/)
    expect(t?.unmetDependencies.join(' ')).toContain('BCN1')
  })

  it('unblocks once every associated IO has a result', () => {
    const pool = buildTaskPool(emptySnapshot({ devices: mkDevices('Passed', 'Failed'), functional }))
    expect(byId(pool.tasks, fid)?.state).toBe('available')
  })

  it('falls back to global rules when no prefix can be derived', () => {
    // Phase-1 IO checks must be complete (results on every IO) so the only
    // thing under test here is the association fallback — not the phase gate.
    const pool = buildTaskPool(
      emptySnapshot({
        devices: mkDevices('Passed', 'Failed'),
        functional: [
          { sheetName: 'SS', displayName: 'Start/Stop', deviceName: 'SS1', order: 0, completedChecks: 0, totalChecks: 2 },
        ],
      }),
    )
    expect(byId(pool.tasks, taskId('functional_check', 'SS:SS1'))?.state).toBe('available')
  })
})

describe('Phase gate — Functional Validation locked until IO Checkout (Phase 1) done', () => {
  const functional = [
    { sheetName: 'SS', displayName: 'Start/Stop', deviceName: 'XYZ1', order: 0, completedChecks: 0, totalChecks: 2 },
  ]
  const fid = taskId('functional_check', 'SS:XYZ1')

  it('blocks functional while a Phase-1 IO check is incomplete', () => {
    const pool = buildTaskPool(
      emptySnapshot({
        devices: [device('DPM1', 0, [io(1, null, false, { name: 'A', description: 'A point' })])],
        functional,
      }),
    )
    const t = byId(pool.tasks, fid)
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies.join(' ')).toMatch(/Complete IO Checkout first/)
  })

  it('unlocks functional once every Phase-1 task is complete', () => {
    const pool = buildTaskPool(
      emptySnapshot({
        devices: [device('DPM1', 0, [io(1, 'Passed', false, { name: 'A', description: 'A point' })])],
        functional,
      }),
    )
    expect(byId(pool.tasks, fid)?.state).toBe('available')
  })

  it('treats a skipped Phase-1 task as done (functional unlocks)', () => {
    const pool = buildTaskPool(
      emptySnapshot({
        devices: [device('DPM1', 0, [io(1, null, false, { name: 'A', description: 'A point' })])],
        functional,
        manualTaskStatus: {
          [taskId('io_check_nonsafety', 'DPM1')]: { status: 'skipped', reason: 'n/a' },
        },
      }),
    )
    expect(byId(pool.tasks, fid)?.state).toBe('available')
  })
})

describe('D4 — system-running gate for functional checks', () => {
  const functional = [
    { sheetName: 'SS', displayName: 'Start/Stop', deviceName: 'SS1', order: 0, completedChecks: 0, totalChecks: 2 },
  ]

  it('blocks functional checks when the system is confirmed stopped', () => {
    const t = byId(
      buildTaskPool(emptySnapshot({ functional, systemRunning: false })).tasks,
      taskId('functional_check', 'SS:SS1'),
    )
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies).toContain('System must be started — all conveyors running')
  })

  it('does not block when running or unknown', () => {
    for (const systemRunning of [true, null]) {
      const t = byId(
        buildTaskPool(emptySnapshot({ functional, systemRunning })).tasks,
        taskId('functional_check', 'SS:SS1'),
      )
      expect(t?.state).toBe('available')
    }
  })
})

describe('D5 — degraded DPM ring gates everything downstream', () => {
  it('blocks VFD / IO / e-stop / functional tasks on a confirmed-degraded ring', () => {
    const snap = emptySnapshot({
      ringHealth: 'degraded',
      vfds: [{ deviceName: 'VFD1', order: 0, steps: [{ name: 'Verify Identity', value: null }], controlsVerified: false }],
      devices: [
        device('SAFE1', 0, [io(1, null, true)], { isSafety: true }),
        device('PE1', 1, [io(2, null, false)], { isSafety: false }),
      ],
      estopZones: [{ zoneName: 'Zone 1', epcs: [{ name: 'EPC1', checkTag: 'T1', result: null, finalResult: null }], safetyDeviceNames: [] }],
      functional: [
        { sheetName: 'SS', displayName: 'Start/Stop', deviceName: 'SS1', order: 0, completedChecks: 0, totalChecks: 2 },
      ],
    })
    const pool = buildTaskPool(snap)
    const dep = 'DPM ring health must be nominal (ring is FAULTED)'
    for (const id of [
      taskId('vfd_setup', 'VFD1'),
      taskId('io_check_safety', 'SAFE1'),
      taskId('io_check_nonsafety', 'PE1'),
      taskId('estop_verification', 'Zone 1'),
      taskId('functional_check', 'SS:SS1'),
    ]) {
      const t = byId(pool.tasks, id)
      expect(t?.state, id).toBe('blocked')
      expect(t?.unmetDependencies, id).toContain(dep)
    }
    expect(pool.nextTaskId).toBeNull()
  })

  it('does not block on healthy or unknown ring', () => {
    for (const ringHealth of ['healthy', 'unknown', null] as const) {
      const snap = emptySnapshot({
        ringHealth,
        devices: [device('PE1', 0, [io(1, null)])],
      })
      expect(byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))?.state).toBe('available')
    }
  })
})

describe('D6 — NC pre-check gates the IO-check task', () => {
  it('blocks the task while an untested NC point reads FALSE at rest', () => {
    const snap = emptySnapshot({
      devices: [
        device('PE1', 0, [io(1, null, false, { name: 'PS8_10_CH4_PE1', circuit: 'NC', liveState: 'FALSE' })]),
      ],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies.join(' ')).toMatch(/Pre-check failed/)
    expect(t?.unmetDependencies.join(' ')).toMatch(/reads FALSE at rest/)
  })

  it('does not block when the NC point reads TRUE or live state is unknown', () => {
    for (const liveState of ['TRUE', null] as const) {
      const snap = emptySnapshot({
        devices: [device('PE1', 0, [io(1, null, false, { circuit: 'NC', liveState })])],
      })
      expect(byId(buildTaskPool(snap).tasks, taskId('io_check_nonsafety', 'PE1'))?.state).toBe('available')
    }
  })

  it('ignores the pre-check for NO points and for already-tested NC points', () => {
    const snap = emptySnapshot({
      devices: [
        device('PB1', 0, [io(1, null, false, { circuit: 'NO', liveState: 'FALSE' })]),
        device('PE2', 1, [io(2, 'Passed', false, { circuit: 'NC', liveState: 'FALSE' })]),
      ],
    })
    const pool = buildTaskPool(snap)
    expect(byId(pool.tasks, taskId('io_check_nonsafety', 'PB1'))?.state).toBe('available')
    expect(byId(pool.tasks, taskId('io_check_nonsafety', 'PE2'))?.state).toBe('completed')
  })
})

describe('D6 — io_check steps carry the circuit + round-trip instruction', () => {
  const ioTask: Task = {
    id: taskId('io_check_nonsafety', 'PE1'),
    type: 'io_check_nonsafety',
    phase: 'Commissioning',
    segment: 'Non-Safety Device I/O Check',
    priority: 5,
    title: 'IO Check PE1',
    deviceName: 'PE1',
    state: 'available',
    steps: [],
    unmetDependencies: [],
    progress: 0,
  }

  it('classifies a photoeye NC and a pushbutton NO', () => {
    const steps = buildSteps(ioTask, [
      { id: 1, name: 'PS8_10_CH4_PE1', description: 'PHOTOEYE', result: null },
      { id: 2, name: 'PS8_10_CH4_JR1', description: 'JAM RESET PUSHBUTTON', result: null },
    ])
    const checks = steps.filter((s) => s.kind === 'io_check')
    expect(checks[0].circuit).toBe('NC')
    expect(checks[1].circuit).toBe('NO')
    expect(checks[0].instruction).toMatch(/full sequence/i)
  })
})

describe('buildEstopSteps', () => {
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

  it('makes the zone nominal then BOTH dual-safety steps per pending EPC', () => {
    const steps = buildEstopSteps(estop, 'Zone 1', [
      { name: 'EPC1', checkTag: 'T1', result: null, finalResult: null },
      { name: 'EPC2', checkTag: 'T2', result: 'pass', finalResult: 'pass' },
    ])
    expect(steps[0].kind).toBe('manual_confirm')
    // only the pending EPC (EPC1) gets steps; EPC2 has both checks → none.
    const epcSteps = steps.filter((s) => s.kind === 'auto_detect')
    expect(epcSteps).toHaveLength(2)
    expect(epcSteps.every((s) => s.estopCheckTag === 'T1')).toBe(true)
    expect(epcSteps.map((s) => s.estopCheckType)).toEqual(['preliminary', 'final'])
  })

  it('emits only the MISSING check when one of the two is already recorded', () => {
    const steps = buildEstopSteps(estop, 'Zone 1', [
      { name: 'EPC1', checkTag: 'T1', result: 'pass', finalResult: null },
    ])
    const epcSteps = steps.filter((s) => s.kind === 'auto_detect')
    expect(epcSteps).toHaveLength(1)
    expect(epcSteps[0].estopCheckType).toBe('final')
  })
})

// ── readiness diagnostics ────────────────────────────────────────────────────

describe('buildTaskPool readiness', () => {
  it('is ready with a real per-MCM map, devices, PLC, and a nominal ring', () => {
    const pool = buildTaskPool(
      emptySnapshot({
        mapSource: 'mcm-diagram',
        plcConnected: true,
        ioCount: 2,
        devices: [device('D1', 0, [io(1, null), io(2, null)])],
      }),
    )
    expect(pool.readiness.ready).toBe(true)
    expect(pool.readiness.blockers).toEqual([])
    expect(pool.readiness.warnings).toEqual([])
    expect(pool.readiness.deviceCount).toBe(1)
  })

  it('BLOCKS when no map is loaded at all', () => {
    const pool = buildTaskPool(emptySnapshot({ mapSource: 'none', ioCount: 5 }))
    expect(pool.readiness.ready).toBe(false)
    expect(pool.readiness.blockers.join(' ')).toMatch(/no device map/i)
  })

  it('BLOCKS when a map is loaded but resolves 0 of the subsystem’s I/O (wrong MCM)', () => {
    const pool = buildTaskPool(
      emptySnapshot({ mapSource: 'mcm-diagram', ioCount: 40, devices: [] }),
    )
    expect(pool.readiness.ready).toBe(false)
    expect(pool.readiness.blockers.join(' ')).toMatch(/0 of 40/)
  })

  it('does NOT block when the subsystem genuinely has no I/O (ioCount 0)', () => {
    const pool = buildTaskPool(emptySnapshot({ mapSource: 'mcm-diagram', ioCount: 0, devices: [] }))
    expect(pool.readiness.ready).toBe(true)
    expect(pool.readiness.blockers).toEqual([])
  })

  it('WARNS (not blocks) when using the bundled fallback map with devices resolved', () => {
    const pool = buildTaskPool(
      emptySnapshot({
        mapSource: 'bundled-fallback',
        ioCount: 1,
        devices: [device('D1', 0, [io(1, null)])],
      }),
    )
    expect(pool.readiness.ready).toBe(true)
    expect(pool.readiness.warnings.join(' ')).toMatch(/bundled map/i)
  })

  it('WARNS when the PLC is not connected (manual entry still works)', () => {
    const pool = buildTaskPool(
      emptySnapshot({
        mapSource: 'mcm-diagram',
        plcConnected: false,
        ioCount: 1,
        devices: [device('D1', 0, [io(1, null)])],
      }),
    )
    expect(pool.readiness.ready).toBe(true)
    expect(pool.readiness.warnings.join(' ')).toMatch(/PLC not connected/i)
  })

  it('WARNS when the DPM ring is degraded', () => {
    const pool = buildTaskPool(
      emptySnapshot({
        mapSource: 'mcm-diagram',
        ringHealth: 'degraded',
        ioCount: 1,
        devices: [device('D1', 0, [io(1, null)])],
      }),
    )
    expect(pool.readiness.warnings.join(' ')).toMatch(/ring is FAULTED/i)
  })
})
