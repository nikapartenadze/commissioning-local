/**
 * Shared simple-outbox drainer (lib/cloud/drain-simple-queue.ts).
 *
 * This is the consolidation of the three near-identical drains (e-stop,
 * guided-task-state, device-blocker-shaped) that had DRIFTED apart — one of
 * them (e-stop) had shipped a transient-strike bug the others already fixed.
 * Pinning the shared loop's strike-vs-no-strike-vs-park decision here means the
 * hardened classification can never diverge between queues again.
 *
 * Companion to __tests__/sync-retry-cap.test.ts, which pins the pure
 * isNetworkLevelFailure classifier; this pins the LOOP that consumes it against
 * a real in-memory SQLite queue + a mocked fetch.
 *
 * Contract under test (identical to the IO / L2 / device-blocker drains):
 *   - resp.ok                          → delete ALL rows for the identity
 *   - permanent 4xx (400/404/409)      → burn exactly ONE strike, keep the row
 *   - network-level (429/≥500/401)     → note error, NO strike, STOP the batch
 *   - fetch threw                       → NO strike, STOP the batch
 *   - RetryCount >= cap                 → PARK (DeadLettered=1), audit, keep row,
 *                                          and do NOT even attempt the POST
 *   - dedupe keeps the preferred row and deletes the rest as stale
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const auditLog = vi.fn()
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: (...a: any[]) => auditLog(...a) }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3')
import { drainSimpleQueue, type SimpleQueueRow } from '@/lib/cloud/drain-simple-queue'

const memDb = new Database(':memory:')

type Row = SimpleQueueRow & { EntityKey: string; Version: number }

function buildSchema() {
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS Q (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER,
      EntityKey TEXT,
      Version INTEGER DEFAULT 0,
      RetryCount INTEGER DEFAULT 0,
      DeadLettered INTEGER DEFAULT 0,
      LastError TEXT,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
  `)
}

function seed(row: { SubsystemId?: number; EntityKey: string; Version?: number; RetryCount?: number; DeadLettered?: number }) {
  return memDb.prepare(
    'INSERT INTO Q (SubsystemId, EntityKey, Version, RetryCount, DeadLettered) VALUES (?, ?, ?, ?, ?)',
  ).run(row.SubsystemId ?? 1, row.EntityKey, row.Version ?? 0, row.RetryCount ?? 0, row.DeadLettered ?? 0)
}

const rowById = (id: number | bigint) => memDb.prepare('SELECT * FROM Q WHERE id = ?').get(id) as any
const allActive = () => memDb.prepare('SELECT * FROM Q WHERE DeadLettered = 0 ORDER BY id').all() as any[]

// Standard options — identity = EntityKey, keep the newest (highest id).
function opts(overrides: Partial<Parameters<typeof drainSimpleQueue<Row>>[0]> = {}) {
  return {
    db: memDb,
    tableName: 'Q',
    retryCap: 10,
    remoteUrl: 'https://cloud.example',
    apiPassword: 'secret',
    endpoint: '/api/sync/thing',
    dedupeKey: (p: Row) => `${p.SubsystemId}|${p.EntityKey}`,
    preferReplacement: (candidate: Row, existing: Row) => candidate.id > existing.id,
    buildBody: (p: Row) => ({ key: p.EntityKey }),
    deleteRowsForIdentity: (p: Row) => { memDb.prepare('DELETE FROM Q WHERE SubsystemId = ? AND EntityKey = ?').run(p.SubsystemId, p.EntityKey) },
    park: {
      defaultError: 'thing retry cap exhausted',
      auditReason: 'thing retry cap exhausted',
      auditDetail: (p: Row) => ({ key: p.EntityKey, retries: p.RetryCount }),
      logMessage: (p: Row) => `PARKED thing id=${p.id}`,
    },
    ...overrides,
  }
}

function stubFetch(fn: (url: string, init: any) => any) {
  const mock = vi.fn(fn)
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => {
  memDb.exec('DROP TABLE IF EXISTS Q;')
  buildSchema()
  auditLog.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('drainSimpleQueue — retry-cap classification', () => {
  it('resp.ok deletes ALL rows for the identity and hits the contracted endpoint', async () => {
    seed({ EntityKey: 'A' })
    const fetchMock = stubFetch(async (url, init) => {
      expect(url).toBe('https://cloud.example/api/sync/thing')
      expect(init.headers['X-API-Key']).toBe('secret')
      expect(JSON.parse(init.body)).toEqual({ key: 'A' })
      return { ok: true, status: 200 }
    })
    await drainSimpleQueue(opts())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(allActive()).toHaveLength(0)
  })

  it('permanent 4xx (400) burns exactly ONE strike and keeps the row', async () => {
    const r = seed({ EntityKey: 'A' })
    stubFetch(async () => ({ ok: false, status: 400 }))
    await drainSimpleQueue(opts())
    const after = rowById(r.lastInsertRowid)
    expect(after.RetryCount).toBe(1)
    expect(after.DeadLettered).toBe(0)
    expect(after.LastError).toBe('HTTP 400')
  })

  it.each([429, 500, 503, 401])('network-level %i sets LastError WITHOUT a strike and STOPS the batch', async (status) => {
    const r1 = seed({ EntityKey: 'A' })
    const r2 = seed({ EntityKey: 'B' })
    const fetchMock = stubFetch(async () => ({ ok: false, status }))
    await drainSimpleQueue(opts())
    // Only the first row was attempted — the batch stopped.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const a = rowById(r1.lastInsertRowid)
    expect(a.RetryCount).toBe(0)
    expect(a.LastError).toBe(`HTTP ${status} (network-level, no strike)`)
    // The second row is completely untouched (still queued for the next cycle).
    const b = rowById(r2.lastInsertRowid)
    expect(b.RetryCount).toBe(0)
    expect(b.LastError).toBeNull()
  })

  it('fetch throwing (offline) leaves the row with NO strike and stops the batch', async () => {
    const r1 = seed({ EntityKey: 'A' })
    const r2 = seed({ EntityKey: 'B' })
    const fetchMock = stubFetch(async () => { throw new Error('network down') })
    await drainSimpleQueue(opts())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(rowById(r1.lastInsertRowid).RetryCount).toBe(0)
    expect(rowById(r1.lastInsertRowid).LastError).toBeNull()
    expect(rowById(r2.lastInsertRowid).RetryCount).toBe(0)
  })

  it('a row at the cap is PARKED (DeadLettered=1), audited, and never POSTed', async () => {
    const r = seed({ EntityKey: 'A', RetryCount: 10 })
    const fetchMock = stubFetch(async () => ({ ok: true, status: 200 }))
    await drainSimpleQueue(opts())
    expect(fetchMock).not.toHaveBeenCalled()
    const after = rowById(r.lastInsertRowid)
    expect(after.DeadLettered).toBe(1)
    expect(after.LastError).toBe('thing retry cap exhausted')
    expect(auditLog).toHaveBeenCalledTimes(1)
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sync.push.park',
      subsystemId: 1,
      reason: 'thing retry cap exhausted',
      detail: { key: 'A', retries: 10 },
    }))
  })

  it('park keeps an already-recorded LastError (COALESCE) instead of overwriting it', async () => {
    const r = memDb.prepare(
      'INSERT INTO Q (SubsystemId, EntityKey, RetryCount, LastError) VALUES (1, ?, 10, ?)',
    ).run('A', 'HTTP 409')
    stubFetch(async () => ({ ok: true, status: 200 }))
    await drainSimpleQueue(opts())
    expect(rowById(r.lastInsertRowid).LastError).toBe('HTTP 409')
  })

  it('dedupe keeps the preferred row (newest id) and deletes the rest as stale', async () => {
    const older = seed({ EntityKey: 'A' })
    const newer = seed({ EntityKey: 'A' })
    const bodies: any[] = []
    const fetchMock = stubFetch(async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: false, status: 400 } })
    await drainSimpleQueue(opts())
    // Only the newest row survives dedupe and is the one POSTed.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(rowById(older.lastInsertRowid)).toBeUndefined()
    expect(rowById(newer.lastInsertRowid).RetryCount).toBe(1)
  })

  it('dedupe with preferReplacement=lowest-version keeps the base-version row (e-stop rule)', async () => {
    const hi = seed({ EntityKey: 'A', Version: 5 })
    const lo = seed({ EntityKey: 'A', Version: 2 })
    stubFetch(async () => ({ ok: false, status: 400 }))
    await drainSimpleQueue(opts({ preferReplacement: (c: Row, e: Row) => c.Version < e.Version }))
    // Lowest Version wins; the higher-version duplicate is dropped as stale.
    expect(rowById(hi.lastInsertRowid)).toBeUndefined()
    expect(rowById(lo.lastInsertRowid).RetryCount).toBe(1)
  })

  it('is a no-op on an empty queue (no fetch)', async () => {
    const fetchMock = stubFetch(async () => ({ ok: true, status: 200 }))
    await drainSimpleQueue(opts())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips DeadLettered rows entirely', async () => {
    seed({ EntityKey: 'A', DeadLettered: 1 })
    const fetchMock = stubFetch(async () => ({ ok: true, status: 200 }))
    await drainSimpleQueue(opts())
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
