/**
 * Test: EStop EPC check cloud sync (DATA-LOSS fix).
 *
 * /api/estop/check used to write EStopEpcChecks LOCAL-ONLY — the pass/fail
 * result never reached the cloud. enqueueEstopCheckSync() now:
 *   - inserts an EStopCheckPendingSyncs row carrying the subsystem-scoped,
 *     version-aware payload, and
 *   - fires an immediate push to POST {remoteUrl}/api/sync/estop-checks with
 *     the X-API-Key header and the contracted body shape.
 *
 * On a non-OK / failed push the pending row is LEFT IN PLACE for the
 * background drain (lib/cloud/auto-sync.ts) — never dropped.
 *
 * Mirrors __tests__/device-blocker-sync.test.ts: mock the better-sqlite3
 * singleton with a fresh in-memory DB carrying the verbatim DDL, mock config +
 * the sync queue (run the pushFn inline so the test can await it), and mock
 * global fetch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE IF NOT EXISTS EStopEpcChecks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      ZoneName TEXT NOT NULL,
      CheckTag TEXT NOT NULL,
      Result TEXT,
      Comments TEXT,
      FailureMode TEXT,
      TestedBy TEXT,
      TestedAt TEXT,
      Version INTEGER NOT NULL DEFAULT 1,
      CreatedAt TEXT DEFAULT (datetime('now')),
      UpdatedAt TEXT,
      UNIQUE(SubsystemId, ZoneName, CheckTag)
    );
    CREATE TABLE IF NOT EXISTS EStopCheckPendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      ZoneName TEXT NOT NULL,
      CheckTag TEXT NOT NULL,
      Result TEXT,
      Comments TEXT,
      FailureMode TEXT,
      TestedBy TEXT,
      TestedAt TEXT,
      Version INTEGER NOT NULL DEFAULT 0,
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

import { enqueueEstopCheckSync } from '@/app/api/estop/check/route'

// A pass result already written into EStopEpcChecks (Version=1 after first write).
function seedCheck(opts: { version?: number; result?: string | null } = {}) {
  memDb.prepare(
    `INSERT INTO EStopEpcChecks (SubsystemId, ZoneName, CheckTag, Result, Comments, FailureMode, TestedBy, TestedAt, Version, UpdatedAt)
     VALUES (16, 'Zone A', 'EPC_01_Check', ?, 'looks good', NULL, 'ASH', datetime('now'), ?, datetime('now'))`,
  ).run(opts.result ?? 'pass', opts.version ?? 1)
}

const flush = async () => {
  const fns = pushFns.splice(0)
  for (const fn of fns) await fn()
}

describe('enqueueEstopCheckSync', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM EStopEpcChecks; DELETE FROM EStopCheckPendingSyncs;')
    pushFns.length = 0
    vi.restoreAllMocks()
  })

  it('enqueues a pending-sync row and pushes the contracted body on a successful write', async () => {
    seedCheck({ version: 1, result: 'pass' })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    enqueueEstopCheckSync(16, 'Zone A', 'EPC_01_Check')

    // Pending row created immediately, with the pre-increment base version (0).
    const pendingBefore = memDb.prepare('SELECT * FROM EStopCheckPendingSyncs').all() as any[]
    expect(pendingBefore).toHaveLength(1)
    expect(pendingBefore[0].SubsystemId).toBe(16)
    expect(pendingBefore[0].ZoneName).toBe('Zone A')
    expect(pendingBefore[0].CheckTag).toBe('EPC_01_Check')
    expect(pendingBefore[0].Version).toBe(0)

    await flush()

    // Pushed to the contracted endpoint with X-API-Key + correct body shape.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://cloud.example/api/sync/estop-checks')
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret-key')
    const body = JSON.parse(init.body as string)
    expect(body.subsystemId).toBe(16)
    expect(body.checks).toHaveLength(1)
    expect(body.checks[0]).toMatchObject({
      zoneName: 'Zone A',
      checkTag: 'EPC_01_Check',
      result: 'pass',
      testedBy: 'ASH',
      version: 0,
    })

    // Cloud accepted → pending row cleared.
    const pendingAfter = memDb.prepare('SELECT * FROM EStopCheckPendingSyncs').all()
    expect(pendingAfter).toHaveLength(0)
  })

  it('keeps the pending row when the cloud push fails (HTTP 500) for background retry', async () => {
    seedCheck({ version: 1, result: 'pass' })

    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    enqueueEstopCheckSync(16, 'Zone A', 'EPC_01_Check')
    await flush()

    const pending = memDb.prepare('SELECT * FROM EStopCheckPendingSyncs').all() as any[]
    expect(pending).toHaveLength(1)
    expect(pending[0].RetryCount).toBe(1)
    expect(pending[0].LastError).toContain('500')
  })

  it('keeps the pending row when the network is offline (fetch throws)', async () => {
    seedCheck({ version: 1, result: 'pass' })

    const fetchMock = vi.fn(async () => { throw new Error('network down') })
    vi.stubGlobal('fetch', fetchMock)

    enqueueEstopCheckSync(16, 'Zone A', 'EPC_01_Check')
    await flush()

    const pending = memDb.prepare('SELECT * FROM EStopCheckPendingSyncs').all()
    expect(pending).toHaveLength(1)
  })

  it('carries the subsystem id and pushes the latest local value on a re-test', async () => {
    // First write (version 1)
    seedCheck({ version: 1, result: 'pass' })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    enqueueEstopCheckSync(16, 'Zone A', 'EPC_01_Check')
    await flush()

    // Re-test: the row is updated to fail @ version 2 before enqueue runs.
    memDb.prepare(
      `UPDATE EStopEpcChecks SET Result='fail', FailureMode='Needs proper tension', Version=2 WHERE SubsystemId=16 AND ZoneName='Zone A' AND CheckTag='EPC_01_Check'`,
    ).run()
    enqueueEstopCheckSync(16, 'Zone A', 'EPC_01_Check')
    await flush()

    const lastCall = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    const body = JSON.parse(lastCall[1].body as string)
    expect(body.subsystemId).toBe(16)
    expect(body.checks[0].result).toBe('fail')
    expect(body.checks[0].failureMode).toBe('Needs proper tension')
    // base version = pre-increment = 1
    expect(body.checks[0].version).toBe(1)
  })
})
