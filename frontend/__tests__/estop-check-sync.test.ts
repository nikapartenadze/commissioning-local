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
      CheckType TEXT NOT NULL DEFAULT 'preliminary',
      UNIQUE(SubsystemId, ZoneName, CheckTag, CheckType)
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
      LastError TEXT,
      CheckType TEXT NOT NULL DEFAULT 'preliminary'
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
function seedCheck(opts: { version?: number; result?: string | null; checkType?: string } = {}) {
  memDb.prepare(
    `INSERT INTO EStopEpcChecks (SubsystemId, ZoneName, CheckTag, CheckType, Result, Comments, FailureMode, TestedBy, TestedAt, Version, UpdatedAt)
     VALUES (16, 'Zone A', 'EPC_01_Check', ?, ?, 'looks good', NULL, 'ASH', datetime('now'), ?, datetime('now'))`,
  ).run(opts.checkType ?? 'preliminary', opts.result ?? 'pass', opts.version ?? 1)
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
      // checkType discriminator threads through to the cloud payload so the
      // receiver can store preliminary + final independently.
      checkType: 'preliminary',
      // local stores lowercase 'pass'; the push normalizes to the cloud's
      // required 'Passed'/'Failed' (cloud 400s otherwise).
      result: 'Passed',
      testedBy: 'ASH',
      version: 0,
    })

    // Cloud accepted → pending row cleared.
    const pendingAfter = memDb.prepare('SELECT * FROM EStopCheckPendingSyncs').all()
    expect(pendingAfter).toHaveLength(0)
  })

  // Transient failures (cloud restarting, rate limit, auth blip) must NOT
  // burn strikes toward the park cap on this instant-push path — this is
  // SAFETY data, and the push can fire many times during a cloud flap. The
  // background drain (drain-simple-queue) already classified this correctly;
  // this enqueue-time path had drifted and struck on everything (2026-07-12).
  it.each([[500], [503], [429], [401]])(
    'keeps the pending row WITHOUT a strike on transient HTTP %i',
    async (status) => {
      seedCheck({ version: 1, result: 'pass' })

      const fetchMock = vi.fn(async () => new Response('boom', { status }))
      vi.stubGlobal('fetch', fetchMock)

      enqueueEstopCheckSync(16, 'Zone A', 'EPC_01_Check')
      await flush()

      const pending = memDb.prepare('SELECT * FROM EStopCheckPendingSyncs').all() as any[]
      expect(pending).toHaveLength(1)
      expect(pending[0].RetryCount).toBe(0) // transient — no strike toward the park cap
    },
  )

  it.each([[400], [422]])(
    'strikes (RetryCount+1) on a permanent HTTP %i, row kept for the drain to park',
    async (status) => {
      seedCheck({ version: 1, result: 'pass' })

      const fetchMock = vi.fn(async () => new Response('rejected', { status }))
      vi.stubGlobal('fetch', fetchMock)

      enqueueEstopCheckSync(16, 'Zone A', 'EPC_01_Check')
      await flush()

      const pending = memDb.prepare('SELECT * FROM EStopCheckPendingSyncs').all() as any[]
      expect(pending).toHaveLength(1)
      expect(pending[0].RetryCount).toBe(1)
      expect(pending[0].LastError).toContain(String(status))
    },
  )

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
    expect(body.checks[0].result).toBe('Failed') // normalized from local 'fail'
    expect(body.checks[0].failureMode).toBe('Needs proper tension')
    // base version = pre-increment = 1
    expect(body.checks[0].version).toBe(1)
  })

  it('keeps preliminary and final as TWO independent rows for the same EPC (no collision)', async () => {
    // Same (subsystem, zone, checkTag) but different CheckType — the widened
    // UNIQUE key means these coexist; one must NOT overwrite the other.
    seedCheck({ version: 1, result: 'pass', checkType: 'preliminary' })
    seedCheck({ version: 1, result: 'fail', checkType: 'final' })

    const checks = memDb.prepare('SELECT CheckType, Result FROM EStopEpcChecks ORDER BY CheckType').all() as any[]
    expect(checks).toHaveLength(2)
    expect(checks.map(c => c.CheckType)).toEqual(['final', 'preliminary'])

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    // Enqueue both — each produces its own pending row keyed by CheckType, and
    // its own push carrying the matching checkType. Clearing one does not touch
    // the other's pending row.
    enqueueEstopCheckSync(16, 'Zone A', 'EPC_01_Check', 'preliminary')
    enqueueEstopCheckSync(16, 'Zone A', 'EPC_01_Check', 'final')

    const pending = memDb.prepare('SELECT CheckType FROM EStopCheckPendingSyncs ORDER BY CheckType').all() as any[]
    expect(pending).toHaveLength(2)
    expect(pending.map(p => p.CheckType)).toEqual(['final', 'preliminary'])

    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const bodies = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map(c => JSON.parse(c[1].body as string))
    const byType = Object.fromEntries(bodies.map(b => [b.checks[0].checkType, b.checks[0]]))
    expect(byType.preliminary.result).toBe('Passed')
    expect(byType.final.result).toBe('Failed')

    // Both pending rows cleared independently after their pushes succeed.
    const after = memDb.prepare('SELECT * FROM EStopCheckPendingSyncs').all()
    expect(after).toHaveLength(0)
  })
})

describe('EStopEpcChecks CheckType migration guard (recreate)', () => {
  // Mirrors the idempotent recreate logic in lib/db-sqlite.ts: an OLD table
  // without CheckType is recreated preserving rows; a NEW table is skipped.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')

  function migrateCheckType(d: any) {
    const cols = d.prepare("PRAGMA table_info(EStopEpcChecks)").all() as { name: string }[]
    const tableExists = cols.length > 0
    const hasCheckType = cols.some(c => c.name === 'CheckType')
    if (!tableExists || hasCheckType) return false
    const hadFailureMode = cols.some(c => c.name === 'FailureMode')
    const failureModeSelect = hadFailureMode ? 'FailureMode' : 'NULL'
    const migrate = d.transaction(() => {
      d.exec(`
        CREATE TABLE EStopEpcChecks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          SubsystemId INTEGER NOT NULL, ZoneName TEXT NOT NULL, CheckTag TEXT NOT NULL,
          Result TEXT, Comments TEXT, FailureMode TEXT, TestedBy TEXT, TestedAt TEXT,
          Version INTEGER NOT NULL DEFAULT 1, CreatedAt TEXT DEFAULT (datetime('now')), UpdatedAt TEXT,
          CheckType TEXT NOT NULL DEFAULT 'preliminary',
          UNIQUE(SubsystemId, ZoneName, CheckTag, CheckType)
        );`)
      d.exec(`
        INSERT INTO EStopEpcChecks_new
          (id, SubsystemId, ZoneName, CheckTag, Result, Comments, FailureMode, TestedBy, TestedAt, Version, CreatedAt, UpdatedAt, CheckType)
        SELECT id, SubsystemId, ZoneName, CheckTag, Result, Comments, ${failureModeSelect}, TestedBy, TestedAt, Version, CreatedAt, UpdatedAt, 'preliminary'
        FROM EStopEpcChecks;`)
      d.exec('DROP TABLE EStopEpcChecks;')
      d.exec('ALTER TABLE EStopEpcChecks_new RENAME TO EStopEpcChecks;')
    })
    migrate()
    return true
  }

  it('recreates an old table without CheckType and preserves rows as preliminary', () => {
    const d = new Database(':memory:')
    d.exec(`
      CREATE TABLE EStopEpcChecks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        SubsystemId INTEGER NOT NULL, ZoneName TEXT NOT NULL, CheckTag TEXT NOT NULL,
        Result TEXT, Comments TEXT, FailureMode TEXT, TestedBy TEXT, TestedAt TEXT,
        Version INTEGER NOT NULL DEFAULT 1, CreatedAt TEXT DEFAULT (datetime('now')), UpdatedAt TEXT,
        UNIQUE(SubsystemId, ZoneName, CheckTag)
      );`)
    d.prepare(`INSERT INTO EStopEpcChecks (SubsystemId, ZoneName, CheckTag, Result, Version) VALUES (16, 'Zone A', 'EPC_01_Check', 'pass', 3)`).run()

    expect(migrateCheckType(d)).toBe(true)

    const cols = d.prepare("PRAGMA table_info(EStopEpcChecks)").all() as { name: string }[]
    expect(cols.map(c => c.name)).toContain('CheckType')
    const rows = d.prepare('SELECT * FROM EStopEpcChecks').all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].CheckType).toBe('preliminary')
    expect(rows[0].Result).toBe('pass')
    expect(rows[0].Version).toBe(3)

    // Now a final write coexists (widened key applied).
    d.prepare(`INSERT INTO EStopEpcChecks (SubsystemId, ZoneName, CheckTag, CheckType, Result, Version) VALUES (16, 'Zone A', 'EPC_01_Check', 'final', 'fail', 1)`).run()
    expect((d.prepare('SELECT * FROM EStopEpcChecks').all() as any[])).toHaveLength(2)
  })

  it('is idempotent — a table that already has CheckType is left untouched', () => {
    const d = new Database(':memory:')
    d.exec(`
      CREATE TABLE EStopEpcChecks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        SubsystemId INTEGER NOT NULL, ZoneName TEXT NOT NULL, CheckTag TEXT NOT NULL,
        Result TEXT, Comments TEXT, FailureMode TEXT, TestedBy TEXT, TestedAt TEXT,
        Version INTEGER NOT NULL DEFAULT 1, CreatedAt TEXT DEFAULT (datetime('now')), UpdatedAt TEXT,
        CheckType TEXT NOT NULL DEFAULT 'preliminary',
        UNIQUE(SubsystemId, ZoneName, CheckTag, CheckType)
      );`)
    expect(migrateCheckType(d)).toBe(false)
    expect(migrateCheckType(d)).toBe(false)
  })
})
