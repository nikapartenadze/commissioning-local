/**
 * Fast + complete "Compare with cloud" diff.
 *
 * The old route pulled the WHOLE subsystem (payloads + every testHistory) and
 * deep-compared everything. This rebuild fetches a cheap id→version MANIFEST,
 * unions it with the OUTBOX, computes the DIVERGENT candidate set, and fetches
 * full cloud VALUES for ONLY those. These tests lock:
 *   - a divergent IO surfaces;
 *   - an all-in-sync subsystem fetches the manifest but NEVER the /rows payload;
 *   - a local-only IO absent from the manifest surfaces (orphan completeness —
 *     the "0 in the queue but the pull still warns" case);
 *   - an optimistic local edit (in the outbox) classifies as PUSH, never as
 *     "cloud is behind" (accept_cloud) — the optimistic-version-bump trap;
 *   - every Compare action fires a heartbeat so the cloud pending-count refreshes.
 *
 * Harness mirrors __tests__/estop-check-sync.test.ts: mock the better-sqlite3
 * singleton with an in-memory DB, mock config + the two cloud endpoints (global
 * fetch) + the heartbeat.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb, mocks } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT);
    CREATE TABLE Ios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      Name TEXT, Result TEXT, Comments TEXT, TestedBy TEXT, Timestamp TEXT,
      Version INTEGER DEFAULT 0, Trade TEXT, FailureMode TEXT,
      CloudRemoved INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE PendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      IoId INTEGER NOT NULL, InspectorName TEXT, TestResult TEXT, Comments TEXT,
      State TEXT, Timestamp TEXT, CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0, Version INTEGER DEFAULT 0,
      FailureMode TEXT, Trade TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE TestHistories (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, Result TEXT, Timestamp TEXT);
  `)
  return {
    memDb: d,
    mocks: {
      getConfig: vi.fn(),
      getMcms: vi.fn(),
      sendHeartbeat: vi.fn(),
      auditLog: vi.fn(),
      createBackup: vi.fn(),
    },
  }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
vi.mock('@/lib/config', () => ({ configService: { getConfig: mocks.getConfig, getMcms: mocks.getMcms } }))
vi.mock('@/lib/heartbeat/heartbeat-service', () => ({ sendHeartbeat: mocks.sendHeartbeat }))
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: mocks.auditLog }))
vi.mock('@/lib/db/backup', () => ({ createBackup: mocks.createBackup }))

import { GET } from '@/app/api/sync/diff/route'
import { POST } from '@/app/api/sync/diff/actions/route'
import { selectDivergentCandidates, classifyIo } from '@/lib/sync/sync-diff'
import type { LocalResultRow } from '@/lib/cloud/result-reconciler'

// ── fake Express req/res ──────────────────────────────────────────────────────
function mockRes() {
  const out: { status: number; body: any } = { status: 200, body: undefined }
  const res: any = {
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  return { res, out }
}

interface DiffRow { id: number; classification: string; action: string }
interface DiffResp { success: boolean; summary: any; perSubsystem: Array<{ subsystemId: number; ok: boolean; error?: string; summary?: any; rows?: DiffRow[] }> }

async function callDiff(subsystemId?: number | 'all'): Promise<DiffResp> {
  const req: any = { query: subsystemId != null ? { subsystemId: String(subsystemId) } : {} }
  const { res, out } = mockRes()
  await GET(req, res)
  return out.body as DiffResp
}

async function callAction(body: any) {
  const req: any = { body }
  const { res, out } = mockRes()
  await POST(req, res)
  return out
}

// ── seeding ──────────────────────────────────────────────────────────────────
function seedIo(o: { id: number; sub?: number; result?: string | null; comments?: string | null; version?: number; name?: string }) {
  memDb.prepare('INSERT INTO Ios (id, SubsystemId, Name, Result, Comments, Version) VALUES (?, ?, ?, ?, ?, ?)')
    .run(o.id, o.sub ?? 16, o.name ?? `IO${o.id}`, o.result ?? null, o.comments ?? null, o.version ?? 0)
}
function seedOutbox(ioId: number, dead = 0) {
  memDb.prepare('INSERT INTO PendingSyncs (IoId, TestResult, DeadLettered, CreatedAt) VALUES (?, ?, ?, ?)')
    .run(ioId, 'Passed', dead, new Date().toISOString())
}

// ── cloud endpoint stubs (the two contracted endpoints) ───────────────────────
type Manifest = Array<{ id: number; version: number }>
type CloudRow = { id: number; name?: string; result?: string | null; comments?: string | null; version?: number; timestamp?: string | null }

/** Stubs GET /versions and POST /rows; records which URLs were hit + the /rows ids. */
function stubDiffFetch(manifest: Manifest, rows: CloudRow[]) {
  const calls: Array<{ url: string; ids?: number[] }> = []
  const fetchMock = vi.fn(async (url: string, init?: any) => {
    if (url.endsWith('/versions')) {
      calls.push({ url })
      return new Response(JSON.stringify({ success: true, ios: manifest }), { status: 200 })
    }
    if (url.endsWith('/rows')) {
      const ids = JSON.parse(init.body).ids as number[]
      calls.push({ url, ids })
      return new Response(JSON.stringify({ success: true, ios: rows.filter((r) => ids.includes(r.id)) }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

/** The actions route still fetches the full subsystem payload for push/accept. */
function stubActionsFetch(cloudIos: CloudRow[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/sync/subsystem/')) return new Response(JSON.stringify({ ios: cloudIos }), { status: 200 })
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const localRow = (over: Partial<LocalResultRow> & { id: number }): LocalResultRow => ({
  Result: null, Comments: null, TestedBy: null, Timestamp: null, Version: 0, Trade: null, FailureMode: null, ...over,
})

beforeEach(() => {
  memDb.exec('DELETE FROM Ios; DELETE FROM Subsystems; DELETE FROM PendingSyncs; DELETE FROM TestHistories;')
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  mocks.getConfig.mockResolvedValue({ remoteUrl: 'https://cloud.example', apiPassword: 'secret-key', subsystemId: '16' })
  mocks.getMcms.mockResolvedValue([])
  mocks.sendHeartbeat.mockResolvedValue(undefined)
  mocks.createBackup.mockResolvedValue(undefined)
  memDb.prepare('INSERT INTO Subsystems (id, Name) VALUES (16, ?)').run('MCM16')
})

// ── pure divergence detector ──────────────────────────────────────────────────
describe('selectDivergentCandidates', () => {
  const NONE = new Set<number>()

  it('flags a version mismatch, an in-sync row is NOT a candidate', () => {
    const local = [localRow({ id: 1, Version: 1 }), localRow({ id: 2, Version: 5 })]
    const manifest = [{ id: 1, version: 5 }, { id: 2, version: 5 }]
    const c = selectDivergentCandidates(local, manifest, NONE)
    expect(c.has(1)).toBe(true)   // 1 diverged (local 1 vs cloud 5)
    expect(c.has(2)).toBe(false)  // 2 equal version → provably in_sync, no payload fetch
  })

  it('flags a local-only orphan the manifest lacks entirely (completeness guard)', () => {
    // 0 rows in the outbox, yet a local result whose id the cloud never lists
    // MUST surface — a cursor/outbox-only scan would miss it.
    const c = selectDivergentCandidates([localRow({ id: 7, Version: 3 })], [], NONE)
    expect(c.has(7)).toBe(true)
  })

  it('flags a written cloud-only row (version>0) but SKIPS untested cloud rows (version 0)', () => {
    const manifest = [{ id: 8, version: 4 }, { id: 9, version: 0 }]
    const c = selectDivergentCandidates([], manifest, NONE)
    expect(c.has(8)).toBe(true)   // cloud wrote it → could be cloud_only
    expect(c.has(9)).toBe(false)  // never written → can't be a divergence → stays O(divergent)
  })

  it('always flags an outbox id even when its version matches the manifest', () => {
    const local = [localRow({ id: 3, Version: 5 })]
    const manifest = [{ id: 3, version: 5 }]
    expect(selectDivergentCandidates(local, manifest, new Set([3])).has(3)).toBe(true)
  })
})

// ── outbox override (base-version correctness) ────────────────────────────────
describe('classifyIo outbox override', () => {
  const local = localRow({ id: 1, Result: 'Blocked', Version: 6, Timestamp: '2026-07-20T10:00:00Z' })

  it('a pending local edit whose base LAGS an independently-advanced cloud pushes, not accept', () => {
    // local v6 "Blocked" vs cloud v7 "Passed": a raw compare says cloud_newer.
    const raw = classifyIo(1, 'IO', local, { id: 1, result: 'Passed', version: 7 }, false)
    expect(raw.classification).toBe('cloud_newer')  // the WRONG verdict without the outbox signal
    const outbox = classifyIo(1, 'IO', local, { id: 1, result: 'Passed', version: 7 }, true)
    expect(outbox.classification).toBe('local_newer')
    expect(outbox.action).toBe('push')
  })

  it('a version-tie conflict on a pending edit also becomes a push', () => {
    const l = localRow({ id: 1, Result: 'Blocked', Version: 6, Timestamp: null })
    const conflict = classifyIo(1, 'IO', l, { id: 1, result: 'Passed', version: 6 }, false)
    expect(conflict.classification).toBe('conflict')
    expect(classifyIo(1, 'IO', l, { id: 1, result: 'Passed', version: 6 }, true).action).toBe('push')
  })

  it('does NOT flip a gone-on-cloud pending push (can never land on a removed IO)', () => {
    expect(classifyIo(1, 'IO', local, undefined, true).classification).toBe('gone_on_cloud')
  })
})

// ── route: GET /api/sync/diff ─────────────────────────────────────────────────
describe('GET /api/sync/diff (fast compute)', () => {
  it('surfaces a divergent IO and fetches /rows for ONLY the candidate', async () => {
    seedIo({ id: 1, result: 'Passed', version: 1 })
    const { calls } = stubDiffFetch([{ id: 1, version: 5 }], [{ id: 1, result: 'Failed', version: 5, name: 'IO1' }])

    const body = await callDiff(16)

    expect(body.success).toBe(true)
    const sub = body.perSubsystem[0]
    expect(sub.ok).toBe(true)
    const row = sub.rows!.find((r) => r.id === 1)!
    expect(row.classification).toBe('cloud_newer')
    expect(row.action).toBe('accept_cloud')
    // manifest fetched, and /rows fetched for exactly [1]
    expect(calls.some((c) => c.url.endsWith('/versions'))).toBe(true)
    expect(calls.find((c) => c.url.endsWith('/rows'))!.ids).toEqual([1])
  })

  it('an all-in-sync subsystem fetches the manifest but NEVER the /rows payload', async () => {
    seedIo({ id: 1, result: 'Passed', version: 5 })
    const { calls } = stubDiffFetch([{ id: 1, version: 5 }], [{ id: 1, result: 'Passed', version: 5 }])

    const body = await callDiff(16)

    const sub = body.perSubsystem[0]
    expect(sub.ok).toBe(true)
    expect(sub.rows).toEqual([])
    expect(sub.summary.inSync).toBe(1)
    expect(calls.some((c) => c.url.endsWith('/versions'))).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/rows'))).toBe(false) // zero payloads
  })

  it('surfaces a local-only orphan absent from the manifest with 0 in the outbox', async () => {
    seedIo({ id: 7, result: 'Passed', version: 3 })   // cloud manifest omits id 7
    stubDiffFetch([], [])

    const body = await callDiff(16)

    const row = body.perSubsystem[0].rows!.find((r) => r.id === 7)!
    expect(row.classification).toBe('gone_on_cloud')
    expect(row.action).toBe('tombstone')
  })

  it('classifies an optimistic local edit (outbox) as PUSH, not "cloud behind"', async () => {
    // local "Blocked" v6 (bumped optimistically) vs an independently-advanced
    // cloud "Passed" v7. Without the outbox signal this reads cloud_newer and
    // would discard the tech's fresh result.
    seedIo({ id: 1, result: 'Blocked', version: 6 })
    seedOutbox(1)
    stubDiffFetch([{ id: 1, version: 7 }], [{ id: 1, result: 'Passed', version: 7 }])

    const row = (await callDiff(16)).perSubsystem[0].rows!.find((r) => r.id === 1)!

    expect(row.classification).toBe('local_newer')
    expect(row.action).toBe('push')
  })
})

// ── route: POST /api/sync/diff/actions fires a heartbeat ──────────────────────
describe('POST /api/sync/diff/actions fires a heartbeat', () => {
  it('push queues the row AND calls sendHeartbeat', async () => {
    seedIo({ id: 1, result: 'Passed', version: 2 })
    stubActionsFetch([{ id: 1, version: 5 }])

    const { body } = await callAction({ action: 'push', subsystemId: 16, ids: [1] })

    expect(body.success).toBe(true)
    expect(memDb.prepare('SELECT COUNT(*) c FROM PendingSyncs WHERE IoId = 1').get()).toMatchObject({ c: 1 })
    expect(mocks.sendHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('accept_cloud overwrites local AND calls sendHeartbeat', async () => {
    seedIo({ id: 1, result: 'Passed', version: 1 })
    stubActionsFetch([{ id: 1, result: 'Failed', comments: null, version: 9 }])

    const { body } = await callAction({ action: 'accept_cloud', subsystemId: 16, ids: [1] })

    expect(body.success).toBe(true)
    expect(memDb.prepare('SELECT Result, Version FROM Ios WHERE id = 1').get()).toMatchObject({ Result: 'Failed', Version: 9 })
    expect(mocks.sendHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('tombstone marks removed AND calls sendHeartbeat (no cloud fetch)', async () => {
    seedIo({ id: 1, result: 'Passed', version: 1 })
    seedOutbox(1)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('tombstone must not fetch the cloud') }))

    const { body } = await callAction({ action: 'tombstone', subsystemId: 16, ids: [1] })

    expect(body.success).toBe(true)
    expect(memDb.prepare('SELECT CloudRemoved FROM Ios WHERE id = 1').get()).toMatchObject({ CloudRemoved: 1 })
    expect(memDb.prepare('SELECT COUNT(*) c FROM PendingSyncs WHERE IoId = 1').get()).toMatchObject({ c: 0 })
    expect(mocks.sendHeartbeat).toHaveBeenCalledTimes(1)
  })
})
