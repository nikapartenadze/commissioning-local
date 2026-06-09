/**
 * Test: Guided-Mode task-state cloud sync (DATA-LOSS fix).
 *
 * /api/guided/tasks/complete and /skip used to write GuidedTaskState
 * LOCAL-ONLY — a tester's skip-with-reason or manual "mark done" never reached
 * the cloud. enqueueGuidedTaskStateSync() now:
 *   - inserts a GuidedTaskStatePendingSyncs row, and
 *   - fires an immediate push to POST {remoteUrl}/api/sync/guided-task-state
 *     with the X-API-Key header and the contracted body shape.
 *
 * On a non-OK / failed push the pending row is LEFT IN PLACE for the
 * background drain — never dropped.
 *
 * Mirrors __tests__/device-blocker-sync.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE IF NOT EXISTS GuidedTaskStatePendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      TaskId TEXT NOT NULL,
      Status TEXT NOT NULL,
      Reason TEXT,
      ActorName TEXT,
      UpdatedAt TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0,
      LastError TEXT
    );
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))

vi.mock('@/lib/config', () => ({
  configService: {
    getConfig: vi.fn(async () => ({ remoteUrl: 'https://cloud.example', apiPassword: 'secret-key' })),
  },
}))

// Capture queued push fns and run them lazily on flush() — this models the
// real single-flight queue, where the push reads the LATEST local state at the
// moment it actually runs (not when it was enqueued).
const pushFns: Array<() => Promise<void>> = []
vi.mock('@/lib/cloud/sync-queue', () => ({
  enqueueSyncPush: (_key: string, fn: () => Promise<void>) => { pushFns.push(fn) },
}))

import { enqueueGuidedTaskStateSync } from '@/lib/cloud/guided-task-state-sync'

const flush = async () => {
  const fns = pushFns.splice(0)
  for (const fn of fns) await fn()
}

describe('enqueueGuidedTaskStateSync', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM GuidedTaskStatePendingSyncs')
    pushFns.length = 0
    vi.restoreAllMocks()
  })

  it('enqueues a pending-sync row and pushes the contracted body for a skip', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    enqueueGuidedTaskStateSync(16, 'phase:1|segment:2|task:loop', 'skipped', 'Cable not pulled yet', 'ASH')

    // Pending row created immediately.
    const pendingBefore = memDb.prepare('SELECT * FROM GuidedTaskStatePendingSyncs').all() as any[]
    expect(pendingBefore).toHaveLength(1)
    expect(pendingBefore[0].SubsystemId).toBe(16)
    expect(pendingBefore[0].TaskId).toBe('phase:1|segment:2|task:loop')
    expect(pendingBefore[0].Status).toBe('skipped')
    expect(pendingBefore[0].Reason).toBe('Cable not pulled yet')
    expect(pendingBefore[0].ActorName).toBe('ASH')

    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://cloud.example/api/sync/guided-task-state')
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret-key')
    const body = JSON.parse(init.body as string)
    expect(body.subsystemId).toBe(16)
    expect(body.states).toHaveLength(1)
    expect(body.states[0]).toMatchObject({
      taskId: 'phase:1|segment:2|task:loop',
      status: 'skipped',
      reason: 'Cable not pulled yet',
      actorName: 'ASH',
    })
    expect(typeof body.states[0].updatedAt).toBe('string')

    // Cloud accepted → pending row cleared.
    expect(memDb.prepare('SELECT * FROM GuidedTaskStatePendingSyncs').all()).toHaveLength(0)
  })

  it('pushes a completed status with null reason', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    enqueueGuidedTaskStateSync(7, 'task:vfd', 'completed', null, 'Nika')
    await flush()

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.states[0].status).toBe('completed')
    expect(body.states[0].reason).toBeNull()
    expect(body.states[0].actorName).toBe('Nika')
  })

  it('pushes a cleared status (undo) with null actor/reason', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    enqueueGuidedTaskStateSync(7, 'task:vfd', 'cleared', null, null)
    await flush()

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.states[0].status).toBe('cleared')
    expect(memDb.prepare('SELECT * FROM GuidedTaskStatePendingSyncs').all()).toHaveLength(0)
  })

  it('keeps the pending row when the cloud push fails (HTTP 500) for background retry', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    enqueueGuidedTaskStateSync(16, 'task:x', 'skipped', 'reason', 'ASH')
    await flush()

    const pending = memDb.prepare('SELECT * FROM GuidedTaskStatePendingSyncs').all() as any[]
    expect(pending).toHaveLength(1)
    expect(pending[0].RetryCount).toBe(1)
    expect(pending[0].LastError).toContain('500')
  })

  it('keeps the pending row when the network is offline (fetch throws)', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network down') })
    vi.stubGlobal('fetch', fetchMock)

    enqueueGuidedTaskStateSync(16, 'task:x', 'skipped', 'reason', 'ASH')
    await flush()

    expect(memDb.prepare('SELECT * FROM GuidedTaskStatePendingSyncs').all()).toHaveLength(1)
  })

  it('pushes only the NEWEST queued state when a task changes twice rapidly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    // Two enqueues before draining. The first push to run reads the LATEST
    // queued row (ORDER BY id DESC → 'completed') and clears all rows for the
    // task on success; the second push then finds nothing to send.
    enqueueGuidedTaskStateSync(16, 'task:y', 'skipped', 'first', 'ASH')
    enqueueGuidedTaskStateSync(16, 'task:y', 'completed', null, 'Nika')
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const firstBody = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(firstBody.states[0].status).toBe('completed')
    expect(memDb.prepare('SELECT * FROM GuidedTaskStatePendingSyncs').all()).toHaveLength(0)
  })
})
