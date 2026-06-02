import { describe, expect, it } from 'vitest'
import { buildTaskPool, taskId } from '@/lib/guided/task-pool/task-builder'
import { pickNextTask, TASK_PRIORITY } from '@/lib/guided/task-pool/priority'
import { buildSteps } from '@/lib/guided/task-pool/steps'
import type {
  DataSnapshot,
  SnapshotDevice,
  SnapshotIo,
} from '@/lib/guided/task-pool/snapshot-types'
import type { Task, TaskType } from '@/lib/guided/task-pool/types'

// ── helpers ────────────────────────────────────────────────────────────────

function io(id: number, result: SnapshotIo['result'], safety = false): SnapshotIo {
  return {
    id,
    name: `DEV:I.In_${id}`,
    description: `IO ${id}`,
    result,
    tagType: null,
    isOutput: false,
    isSafety: safety,
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
    devices: [],
    estopZones: [],
    vfds: [],
    functional: [],
    network: { hasRings: false, dpmsAllInstalled: null },
    beltsTracked: null,
    allNetworkedCommunicating: null,
    manualTaskStatus: {},
    ...overrides,
  }
}

const byId = (tasks: Task[], id: string) => tasks.find((t) => t.id === id)

// ── priority ────────────────────────────────────────────────────────────────

describe('TASK_PRIORITY', () => {
  it('follows the commissioning flow order', () => {
    const order: TaskType[] = [
      'network_loop',
      'vfd_setup',
      'io_check_safety',
      'estop_verification',
      'io_check_nonsafety',
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
      estopZones: [{ zoneName: 'Zone 1', epcs: [{ name: 'EPC1', checkTag: 'T1', result: null }] }],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('estop_verification', 'Zone 1'))
    expect(t?.state).toBe('blocked')
    expect(t?.unmetDependencies).toContain('All Safety I/O Check tasks must be done first')
  })

  it('makes e-stop verification available once safety IO checks complete', () => {
    const snap = emptySnapshot({
      devices: [device('SAFE1', 0, [io(1, 'Passed', true)], { isSafety: true })],
      estopZones: [{ zoneName: 'Zone 1', epcs: [{ name: 'EPC1', checkTag: 'T1', result: null }] }],
    })
    const t = byId(buildTaskPool(snap).tasks, taskId('estop_verification', 'Zone 1'))
    expect(t?.state).toBe('available')
  })

  it('completes an e-stop zone when every EPC has a result', () => {
    const snap = emptySnapshot({
      estopZones: [
        {
          zoneName: 'Zone 1',
          epcs: [
            { name: 'EPC1', checkTag: 'T1', result: 'pass' },
            { name: 'EPC2', checkTag: 'T2', result: 'fail' },
          ],
        },
      ],
    })
    expect(byId(buildTaskPool(snap).tasks, taskId('estop_verification', 'Zone 1'))?.state).toBe(
      'completed',
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
    // VFD (2) is highest workable since there's no network ring to gate it,
    // safety devices are not yet done so e-stop would be blocked, etc.
    expect(pool.nextTaskId).toBe(taskId('vfd_setup', 'VFD1'))

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
})
