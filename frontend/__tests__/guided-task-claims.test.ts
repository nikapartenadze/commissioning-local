import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLAIM_TTL_MS,
  _resetClaims,
  applyClaims,
  claimTask,
  getActiveClaims,
  releaseClaim,
} from '@/lib/guided/task-pool/claims'
import type { Task, TaskPool } from '@/lib/guided/task-pool/types'

const T0 = 1_000_000

function task(id: string, priority: number, state: Task['state'] = 'available'): Task {
  return {
    id,
    type: 'io_check_safety',
    phase: 'Commissioning',
    segment: 'Safety Device I/O Check',
    priority,
    title: id,
    deviceName: id.split(':')[1],
    state,
    steps: [],
    unmetDependencies: [],
    progress: 0,
  }
}

function poolOf(tasks: Task[]): TaskPool {
  return {
    subsystemId: 1,
    tasks,
    nextTaskId: tasks[0]?.id ?? null,
    summary: { total: tasks.length, available: tasks.length, inProgress: 0, completed: 0, blocked: 0, skipped: 0 },
    readiness: { ready: true, blockers: [], warnings: [], mapSource: 'mcm-diagram', deviceCount: 1, plcConnected: true },
  }
}

beforeEach(() => _resetClaims())

describe('claimTask / getActiveClaims', () => {
  it('claims, renews, and rejects a different live client on the same task', () => {
    expect(claimTask(1, { taskId: 'io:A', clientId: 'c1', user: 'Nika' }, T0).ok).toBe(true)
    // renew by the same client is fine
    expect(claimTask(1, { taskId: 'io:A', clientId: 'c1' }, T0 + 10_000).ok).toBe(true)
    const other = claimTask(1, { taskId: 'io:A', clientId: 'c2' }, T0 + 15_000)
    expect(other.ok).toBe(false)
    expect(other.heldBy).toBe('Nika')
  })

  it('expires claims after the TTL', () => {
    claimTask(1, { taskId: 'io:A', clientId: 'c1' }, T0)
    expect(getActiveClaims(1, T0 + CLAIM_TTL_MS - 1)).toHaveLength(1)
    expect(getActiveClaims(1, T0 + CLAIM_TTL_MS + 1)).toHaveLength(0)
    // and the task becomes claimable by someone else
    expect(claimTask(1, { taskId: 'io:A', clientId: 'c2' }, T0 + CLAIM_TTL_MS + 1).ok).toBe(true)
  })

  it('one claim per client: claiming a new task releases the previous one', () => {
    claimTask(1, { taskId: 'io:A', clientId: 'c1' }, T0)
    claimTask(1, { taskId: 'io:B', clientId: 'c1' }, T0 + 1000)
    const claims = getActiveClaims(1, T0 + 2000)
    expect(claims).toHaveLength(1)
    expect(claims[0].taskId).toBe('io:B')
    expect(claimTask(1, { taskId: 'io:A', clientId: 'c2' }, T0 + 2000).ok).toBe(true)
  })

  it('release drops the claim; subsystems are independent', () => {
    claimTask(1, { taskId: 'io:A', clientId: 'c1' }, T0)
    claimTask(2, { taskId: 'io:A', clientId: 'c9' }, T0)
    releaseClaim(1, 'c1')
    expect(getActiveClaims(1, T0)).toHaveLength(0)
    expect(getActiveClaims(2, T0)).toHaveLength(1)
  })
})

describe('applyClaims', () => {
  it("stamps other clients' claims and re-picks nextTaskId past them", () => {
    const pool = poolOf([task('io:A', 2), task('io:B', 2), task('io:C', 4)])
    claimTask(1, { taskId: 'io:A', clientId: 'other', user: 'Keith' }, T0)
    const out = applyClaims(pool, getActiveClaims(1, T0 + 1), 'me')
    expect(out.tasks.find((t) => t.id === 'io:A')?.claimedBy).toBe('Keith')
    expect(out.nextTaskId).toBe('io:B')
    expect(out.claims).toEqual([
      { taskId: 'io:A', user: 'Keith', deviceName: null, watchIoIds: [] },
    ])
  })

  it("the caller's own claim is invisible to them", () => {
    const pool = poolOf([task('io:A', 2), task('io:B', 2)])
    claimTask(1, { taskId: 'io:A', clientId: 'me' }, T0)
    const out = applyClaims(pool, getActiveClaims(1, T0 + 1), 'me')
    expect(out.tasks.find((t) => t.id === 'io:A')?.claimedBy).toBeUndefined()
    expect(out.nextTaskId).toBe('io:A')
    expect(out.claims ?? []).toHaveLength(0)
  })

  it('anonymous claims get a stable tester label; watch ids flow through', () => {
    const pool = poolOf([task('io:A', 2)])
    claimTask(1, { taskId: 'io:A', clientId: 'abcd1234', deviceName: 'UL21_2', watchIoIds: [7, 8] }, T0)
    const out = applyClaims(pool, getActiveClaims(1, T0 + 1), 'me')
    expect(out.claims?.[0]).toEqual({
      taskId: 'io:A',
      user: 'Tester ABCD',
      deviceName: 'UL21_2',
      watchIoIds: [7, 8],
    })
    expect(out.nextTaskId).toBeNull() // the only task is claimed
  })
})
