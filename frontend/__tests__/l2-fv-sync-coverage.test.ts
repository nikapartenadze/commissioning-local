/**
 * Both-direction L2 / FV (functional-validation cell) sync — the core merge
 * logic that the existing L2 tests do NOT cover.
 *
 * What was already pinned elsewhere (do NOT duplicate):
 *   - l2-pending-sync-deadletter.test.ts → dead-letter PARK semantics, active
 *     push query skipping parked rows, the auto-pull gate (raw SQL).
 *   - l2-subsystem-scoping.test.ts → scoped pull/read don't cross-wipe MCMs.
 *   - vfd-addressed-sync.test.ts → the SEPARATE VfdAddressed cloud→field mirror.
 *
 * The GAP this file closes is the per-cell value flow in BOTH directions:
 *
 *   FIELD → CLOUD (the REAL POST /api/l2/cell handler):
 *     a local cell edit must (a) write/version-bump L2CellValues, (b) enqueue an
 *     L2PendingSyncs row whose Version is the BASE the cloud has (newVersion-1),
 *     (c) on a cloud ACK drop ALL pending rows for that cell, (d) on a cloud
 *     version CONFLICT rebase the pending base to cloud's version (local stays
 *     authoritative — its value re-pushes), and (e) recount CompletedChecks.
 *     This is the function CI would protect against a regression in the write
 *     path; none of it is asserted today.
 *
 *   CLOUD → FIELD (the version-gated last-write-wins merge):
 *     a cloud `l2_cell_updated` event must apply ONLY when its version is newer
 *     than the local cell (older/equal cloud version is dropped — local is the
 *     authority per CLAUDE.md), and INSERT when the cell is absent locally. The
 *     producer is CloudSseClient.handleL2CellUpdated (a private method that also
 *     fires a WS broadcast over the network), so we drive the EXACT merge SQL it
 *     runs — the load-bearing decision — on the shared in-memory DB.
 *
 * Pattern mirrors vfd-addressed-sync.test.ts: the @/lib/db-sqlite singleton is
 * mocked to a throwaway in-memory SQLite, the REAL DDL from lib/db-sqlite.ts is
 * recreated per test, configService + the per-key sync queue are mocked so the
 * push runs inline, and global fetch is stubbed. Pure node-env (no PLC/cloud).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mirror lib/db-sqlite.ts L2 DDL exactly. Hoisted so the vi.mock factory (also
// hoisted) can see it. FK refs kept; PRAGMA foreign_keys is off by default so
// the parent rows we don't exercise aren't required.
const L2_DDL = vi.hoisted(() => `
  CREATE TABLE L2Sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    CloudId INTEGER, Name TEXT NOT NULL, DisplayName TEXT,
    DisplayOrder INTEGER NOT NULL, Discipline TEXT, DeviceCount INTEGER DEFAULT 0
  );
  CREATE TABLE L2Columns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    CloudId INTEGER, SheetId INTEGER NOT NULL, Name TEXT NOT NULL,
    ColumnType TEXT NOT NULL, InputType TEXT, DisplayOrder INTEGER NOT NULL,
    IsSystem INTEGER DEFAULT 0, IsEditable INTEGER DEFAULT 1,
    IncludeInProgress INTEGER DEFAULT 0, IsRequired INTEGER DEFAULT 0, Description TEXT
  );
  CREATE TABLE L2Devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    CloudId INTEGER, SubsystemId INTEGER, SheetId INTEGER NOT NULL, DeviceName TEXT NOT NULL,
    Mcm TEXT, Subsystem TEXT, DisplayOrder INTEGER NOT NULL,
    CompletedChecks INTEGER DEFAULT 0, TotalChecks INTEGER DEFAULT 0
  );
  CREATE TABLE L2CellValues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    CloudCellId INTEGER, DeviceId INTEGER NOT NULL, ColumnId INTEGER NOT NULL,
    Value TEXT, UpdatedBy TEXT, UpdatedAt TEXT DEFAULT (datetime('now')),
    Version INTEGER DEFAULT 0, UNIQUE(DeviceId, ColumnId)
  );
  CREATE TABLE L2PendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    CloudDeviceId INTEGER NOT NULL, CloudColumnId INTEGER NOT NULL,
    Value TEXT, UpdatedBy TEXT, Version INTEGER DEFAULT 0,
    CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0,
    LastError TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0
  );
`)

// In-memory app DB singleton shared by the route under test and this file.
// The route module prepares its statements at IMPORT time, so the tables must
// exist before that — create them here in the factory (beforeEach recreates
// fresh ones per test; the route's prepared statements re-resolve table names
// at execution time, so DROP/CREATE between tests is fine).
vi.mock('@/lib/db-sqlite', async () => {
  const Database = (await import('better-sqlite3')).default
  const d = new Database(':memory:')
  d.exec(L2_DDL)
  return { db: d }
})

// configService.getConfig() → a cloud config so the push path runs.
vi.mock('@/lib/config', () => ({
  configService: { getConfig: vi.fn(async () => ({ remoteUrl: 'https://cloud.example', apiPassword: 'secret' })) },
}))

// Run the enqueued push INLINE (and synchronously awaitable) so a single POST
// exercises the full field→cloud drain without the real single-flight timing.
const pushFns: Array<() => Promise<void>> = []
vi.mock('@/lib/cloud/sync-queue', () => ({
  enqueueSyncPush: vi.fn((_key: string, fn: () => Promise<void>) => { pushFns.push(fn) }),
}))

// The push dynamically imports the SSE client to track its own echo — stub it.
vi.mock('@/lib/cloud/cloud-sse-client', () => ({
  getCloudSseClient: () => ({ trackPushedL2Id: vi.fn() }),
}))

// Capture recovery-audit events so we can assert the FV write/failure is journaled
// (the durable "reconstruct the work" record). The real module writes JSONL to
// disk and is covered by recovery-log.test.ts; here we only assert the route emits.
const auditEvents: any[] = []
vi.mock('@/lib/logging/recovery-log', () => ({
  auditLog: vi.fn((e: any) => { auditEvents.push(e) }),
}))

import { db } from '@/lib/db-sqlite'
import { POST } from '@/app/api/l2/cell/route'

// ---- helpers -------------------------------------------------------------

function recreateSchema() {
  const d = db as any
  d.exec('DROP TABLE IF EXISTS L2CellValues')
  d.exec('DROP TABLE IF EXISTS L2PendingSyncs')
  d.exec('DROP TABLE IF EXISTS L2Devices')
  d.exec('DROP TABLE IF EXISTS L2Columns')
  d.exec('DROP TABLE IF EXISTS L2Sheets')
  d.exec(L2_DDL)
}

// Seed one sheet/column/device. includeInProgress controls CompletedChecks math.
function seedSkeleton(opts: { cloudDeviceId: number; cloudColumnId: number; includeInProgress?: number }) {
  const d = db as any
  d.prepare('INSERT INTO L2Sheets (id, Name, DisplayOrder) VALUES (1, ?, 0)').run('APF')
  const col = d.prepare(
    'INSERT INTO L2Columns (CloudId, SheetId, Name, ColumnType, DisplayOrder, IncludeInProgress) VALUES (?, 1, ?, ?, 0, ?)'
  ).run(opts.cloudColumnId, 'Direction', 'text', opts.includeInProgress ?? 1)
  const dev = d.prepare(
    'INSERT INTO L2Devices (CloudId, SheetId, DeviceName, DisplayOrder) VALUES (?, 1, ?, 0)'
  ).run(opts.cloudDeviceId, 'CBT_UL21_3_VFD')
  return { deviceId: Number(dev.lastInsertRowid), columnId: Number(col.lastInsertRowid) }
}

// Minimal Express req/res doubles for the route handler.
function makeReqRes(body: any) {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this },
    json(payload: any) { this.body = payload; return this },
  }
  return { req: { body } as any, res }
}

async function drainPushes() {
  const fns = pushFns.splice(0, pushFns.length)
  for (const fn of fns) await fn()
}

const cell = (deviceId: number, columnId: number) =>
  (db as any).prepare('SELECT Value, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?').get(deviceId, columnId) as { Value: string | null; Version: number } | undefined
const pendingFor = (cd: number, cc: number) =>
  (db as any).prepare('SELECT * FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ? ORDER BY id').all(cd, cc) as any[]

// The EXACT merge handleL2CellUpdated runs (minus the network WS broadcast),
// so the version-gated last-write-wins decision is asserted directly.
function applyCloudL2Cell(data: { cloudDeviceId: number; cloudColumnId: number; value: string | null; version: number; updatedBy: string | null; updatedAt: string }): 'applied' | 'skipped-no-mapping' | 'skipped-stale' {
  const d = db as any
  const localDev = d.prepare('SELECT id FROM L2Devices WHERE CloudId = ?').get(data.cloudDeviceId) as { id: number } | undefined
  const localCol = d.prepare('SELECT id FROM L2Columns WHERE CloudId = ?').get(data.cloudColumnId) as { id: number } | undefined
  if (!localDev || !localCol) return 'skipped-no-mapping'
  const existing = d.prepare('SELECT id, Version FROM L2CellValues WHERE DeviceId = ? AND ColumnId = ?').get(localDev.id, localCol.id) as { id: number; Version: number } | undefined
  if (existing && existing.Version >= data.version) return 'skipped-stale'
  if (existing) {
    d.prepare('UPDATE L2CellValues SET Value = ?, UpdatedBy = ?, UpdatedAt = ?, Version = ? WHERE id = ?')
      .run(data.value, data.updatedBy, data.updatedAt, data.version, existing.id)
  } else {
    d.prepare('INSERT INTO L2CellValues (DeviceId, ColumnId, Value, UpdatedBy, UpdatedAt, Version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(localDev.id, localCol.id, data.value, data.updatedBy, data.updatedAt, data.version)
  }
  const cc = d.prepare(`SELECT COUNT(*) as cnt FROM L2CellValues cv JOIN L2Columns lc ON cv.ColumnId = lc.id WHERE cv.DeviceId = ? AND lc.IncludeInProgress = 1 AND cv.Value IS NOT NULL AND cv.Value != ''`).get(localDev.id) as { cnt: number }
  d.prepare('UPDATE L2Devices SET CompletedChecks = ? WHERE id = ?').run(cc.cnt, localDev.id)
  return 'applied'
}

beforeEach(() => {
  recreateSchema()
  pushFns.length = 0
  auditEvents.length = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// =====================================================================
// FIELD → CLOUD — the real POST /api/l2/cell handler
// =====================================================================
describe('field→cloud: POST /api/l2/cell writes the cell + enqueues a versioned PendingSync', () => {
  it('rejects a request missing deviceId/columnId (400, no DB write)', async () => {
    const { req, res } = makeReqRes({ value: 'x' })
    await POST(req, res)
    expect(res.statusCode).toBe(400)
    expect((db as any).prepare('SELECT COUNT(*) c FROM L2CellValues').get().c).toBe(0)
  })

  it('rejects a stale/unknown deviceId with 404 and writes NOTHING (no orphan cell)', async () => {
    // A device id that does not exist locally — e.g. a queued edit replayed
    // after a pull renumbered the local ids. Must NOT insert an orphan cell.
    seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    const goodCol = (db as any).prepare('SELECT id FROM L2Columns LIMIT 1').get().id
    vi.stubGlobal('fetch', vi.fn())
    const { req, res } = makeReqRes({ deviceId: 999999, columnId: goodCol, value: 'x', updatedBy: 't' })
    await POST(req, res)
    expect(res.statusCode).toBe(404)
    expect((db as any).prepare('SELECT COUNT(*) c FROM L2CellValues').get().c).toBe(0)
  })

  it('first edit: inserts cell v1 and enqueues a pending row at BASE version 0', async () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    vi.stubGlobal('fetch', vi.fn())
    const { req, res } = makeReqRes({ deviceId, columnId, value: 'Forward', updatedBy: 'tech@x' })
    await POST(req, res)

    expect(res.body).toMatchObject({ success: true, version: 1, completedChecks: 1 })
    expect(cell(deviceId, columnId)).toMatchObject({ Value: 'Forward', Version: 1 })
    const pend = pendingFor(900, 700)
    expect(pend).toHaveLength(1)
    // The pending base version is the value the cloud has = newVersion-1 = 0.
    expect(pend[0]).toMatchObject({ Value: 'Forward', Version: 0, UpdatedBy: 'tech@x', DeadLettered: 0 })
  })

  it('does NOT enqueue a pending row when the device/column has no CloudId (unmapped)', async () => {
    // Device/column exist locally but carry NO CloudId — nothing to push.
    const d = db as any
    d.prepare('INSERT INTO L2Sheets (id, Name, DisplayOrder) VALUES (1, ?, 0)').run('APF')
    const col = d.prepare('INSERT INTO L2Columns (SheetId, Name, ColumnType, DisplayOrder, IncludeInProgress) VALUES (1, ?, ?, 0, 1)').run('Direction', 'text')
    const dev = d.prepare('INSERT INTO L2Devices (SheetId, DeviceName, DisplayOrder) VALUES (1, ?, 0)').run('LOCAL_ONLY')
    const deviceId = Number(dev.lastInsertRowid), columnId = Number(col.lastInsertRowid)
    vi.stubGlobal('fetch', vi.fn())
    const { req, res } = makeReqRes({ deviceId, columnId, value: 'Reverse', updatedBy: 'tech@x' })
    await POST(req, res)
    expect(res.body.success).toBe(true)
    expect(cell(deviceId, columnId)).toMatchObject({ Value: 'Reverse', Version: 1 })
    expect((db as any).prepare('SELECT COUNT(*) c FROM L2PendingSyncs').get().c).toBe(0)
  })

  it('drain on cloud ACK drops ALL pending rows for the cell', async () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    // Pre-existing stale pending row for the same cell (accumulated while offline).
    ;(db as any).prepare('INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, Version) VALUES (900, 700, ?, 0)').run('older')
    const fetchSpy = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('https://cloud.example/api/sync/l2/update')
      expect(init.headers['X-API-Key']).toBe('secret')
      const sent = JSON.parse(init.body)
      // Pushes the LATEST local value at the OLDEST pending base version (0).
      expect(sent.updates[0]).toMatchObject({ deviceId: 900, columnId: 700, value: 'Forward', version: 0 })
      return { ok: true, status: 200, json: async () => ({ updates: [{ deviceId: 900, columnId: 700 }] }) }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { req, res } = makeReqRes({ deviceId, columnId, value: 'Forward', updatedBy: 'tech@x' })
    await POST(req, res)
    await drainPushes()
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(pendingFor(900, 700)).toHaveLength(0) // every pending row for the cell cleared
  })

  it('drain on a cloud version CONFLICT rebases the pending base (local value still wins next push)', async () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ updates: [], conflicts: [{ deviceId: 900, columnId: 700, cloudVersion: 5 }] }),
    })))
    const { req, res } = makeReqRes({ deviceId, columnId, value: 'Forward', updatedBy: 'tech@x' })
    await POST(req, res)
    await drainPushes()
    const pend = pendingFor(900, 700)
    expect(pend).toHaveLength(1)             // NOT dropped — local is authoritative
    expect(pend[0].Version).toBe(5)          // base rebased to cloud's version
    expect(pend[0].RetryCount).toBe(1)       // strike counted (cap still fires; no livelock)
    expect(pend[0].LastError).toMatch(/rebased/)
    expect(cell(deviceId, columnId)!.Value).toBe('Forward') // local value untouched
  })

  it('drain leaves the pending row intact on an HTTP error (background retry will pick it up)', async () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const { req, res } = makeReqRes({ deviceId, columnId, value: 'Forward', updatedBy: 'tech@x' })
    await POST(req, res)
    await drainPushes()
    expect(pendingFor(900, 700)).toHaveLength(1) // not lost on a server error
  })

  it('drain never throws and preserves the pending row when fetch rejects', async () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const { req, res } = makeReqRes({ deviceId, columnId, value: 'Forward', updatedBy: 'tech@x' })
    await POST(req, res)
    await expect(drainPushes()).resolves.toBeUndefined()
    expect(pendingFor(900, 700)).toHaveLength(1)
  })

  it('a second edit bumps the cell to v2 and enqueues a second pending row based at v1', async () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    vi.stubGlobal('fetch', vi.fn()) // no drain — just inspect the enqueue
    await POST(...Object.values(makeReqRes({ deviceId, columnId, value: 'Forward', updatedBy: 'a' })) as [any, any])
    await POST(...Object.values(makeReqRes({ deviceId, columnId, value: 'Reverse', updatedBy: 'b' })) as [any, any])
    expect(cell(deviceId, columnId)).toMatchObject({ Value: 'Reverse', Version: 2 })
    const pend = pendingFor(900, 700)
    expect(pend.map(p => p.Version)).toEqual([0, 1]) // bases: cloud-had-0, then cloud-had-1
  })
})

// =====================================================================
// AUDIT JOURNAL — every FV write and every un-syncable edit is recorded
// so lost work can be reconstructed from logs/audit-*.jsonl (the "recover
// data" guarantee). Mirrors io.test journaling for IO results.
// =====================================================================
describe('audit: POST /api/l2/cell journals the FV write and un-syncable edits', () => {
  it('emits an l2.cell audit event with device/column/value/version/user on a successful save', async () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    vi.stubGlobal('fetch', vi.fn())
    const { req, res } = makeReqRes({ deviceId, columnId, value: 'Forward', updatedBy: 'tech@x' })
    await POST(req, res)

    const evt = auditEvents.find(e => e.type === 'l2.cell')
    expect(evt).toBeTruthy()
    expect(evt.user).toBe('tech@x')
    expect(evt.version).toBe(1)
    expect(evt.detail).toMatchObject({ deviceId, columnId, cloudDeviceId: 900, cloudColumnId: 700, value: 'Forward' })
  })

  it('emits an l2.push.drop (unmapped) audit event when the cell has no CloudId to sync', async () => {
    // Device/column exist locally but carry NO CloudId — the cell is saved
    // durably but can NEVER reach the cloud. That must not be silent.
    const d = db as any
    d.prepare('INSERT INTO L2Sheets (id, Name, DisplayOrder) VALUES (1, ?, 0)').run('APF')
    const col = d.prepare('INSERT INTO L2Columns (SheetId, Name, ColumnType, DisplayOrder, IncludeInProgress) VALUES (1, ?, ?, 0, 1)').run('Direction', 'text')
    const dev = d.prepare('INSERT INTO L2Devices (SheetId, DeviceName, DisplayOrder) VALUES (1, ?, 0)').run('LOCAL_ONLY')
    const deviceId = Number(dev.lastInsertRowid), columnId = Number(col.lastInsertRowid)
    vi.stubGlobal('fetch', vi.fn())
    const { req, res } = makeReqRes({ deviceId, columnId, value: 'Reverse', updatedBy: 'tech@x' })
    await POST(req, res)

    expect(cell(deviceId, columnId)).toMatchObject({ Value: 'Reverse', Version: 1 }) // still durable locally
    const drop = auditEvents.find(e => e.type === 'l2.push.drop')
    expect(drop).toBeTruthy()
    expect(drop.reason).toMatch(/unmapped|CloudId/i)
    expect(drop.detail).toMatchObject({ deviceId, columnId })
  })
})

// =====================================================================
// CLOUD → FIELD — version-gated last-write-wins merge (handleL2CellUpdated SQL)
// =====================================================================
describe('cloud→field: L2 cell merge is version-gated last-write-wins', () => {
  it('inserts a cell that does not exist locally yet', () => {
    seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    const r = applyCloudL2Cell({ cloudDeviceId: 900, cloudColumnId: 700, value: 'Forward', version: 3, updatedBy: 'cloud@x', updatedAt: '2026-06-27T00:00:00Z' })
    expect(r).toBe('applied')
    const dev = (db as any).prepare('SELECT id, CompletedChecks FROM L2Devices WHERE CloudId = 900').get()
    expect(cell(dev.id, (db as any).prepare('SELECT id FROM L2Columns WHERE CloudId = 700').get().id)).toMatchObject({ Value: 'Forward', Version: 3 })
    expect(dev.CompletedChecks).toBe(1) // recounted on apply
  })

  it('applies a cloud update when the cloud version is NEWER than local', () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    ;(db as any).prepare('INSERT INTO L2CellValues (DeviceId, ColumnId, Value, Version) VALUES (?, ?, ?, 2)').run(deviceId, columnId, 'old')
    const r = applyCloudL2Cell({ cloudDeviceId: 900, cloudColumnId: 700, value: 'new', version: 3, updatedBy: 'cloud@x', updatedAt: 't' })
    expect(r).toBe('applied')
    expect(cell(deviceId, columnId)).toMatchObject({ Value: 'new', Version: 3 })
  })

  it('SKIPS a cloud update whose version is OLDER than local (local stays authoritative)', () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    ;(db as any).prepare('INSERT INTO L2CellValues (DeviceId, ColumnId, Value, Version) VALUES (?, ?, ?, 5)').run(deviceId, columnId, 'local-wins')
    const r = applyCloudL2Cell({ cloudDeviceId: 900, cloudColumnId: 700, value: 'stale-cloud', version: 4, updatedBy: 'cloud@x', updatedAt: 't' })
    expect(r).toBe('skipped-stale')
    expect(cell(deviceId, columnId)).toMatchObject({ Value: 'local-wins', Version: 5 })
  })

  it('SKIPS a cloud update whose version EQUALS local (idempotent echo, no clobber)', () => {
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    ;(db as any).prepare('INSERT INTO L2CellValues (DeviceId, ColumnId, Value, Version) VALUES (?, ?, ?, 3)').run(deviceId, columnId, 'mine')
    const r = applyCloudL2Cell({ cloudDeviceId: 900, cloudColumnId: 700, value: 'echo', version: 3, updatedBy: 'cloud@x', updatedAt: 't' })
    expect(r).toBe('skipped-stale')
    expect(cell(deviceId, columnId)).toMatchObject({ Value: 'mine', Version: 3 })
  })

  it('SKIPS (no crash) when the cloud device/column is not mapped into this MCM', () => {
    seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    const r = applyCloudL2Cell({ cloudDeviceId: 999, cloudColumnId: 700, value: 'x', version: 9, updatedBy: 'c', updatedAt: 't' })
    expect(r).toBe('skipped-no-mapping')
    expect((db as any).prepare('SELECT COUNT(*) c FROM L2CellValues').get().c).toBe(0)
  })

  it('round-trip: a field push base-version then a NEWER cloud merge converges (last-write-wins)', async () => {
    // FIELD writes v1 (base 0 enqueued).
    const { deviceId, columnId } = seedSkeleton({ cloudDeviceId: 900, cloudColumnId: 700 })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ updates: [{ deviceId: 900, columnId: 700 }] }) })))
    await POST(...Object.values(makeReqRes({ deviceId, columnId, value: 'field-v1', updatedBy: 'tech' })) as [any, any])
    await drainPushes()
    expect(cell(deviceId, columnId)).toMatchObject({ Value: 'field-v1', Version: 1 })
    // CLOUD later reports a NEWER version for the same cell (another tech edited it) → applied.
    const r = applyCloudL2Cell({ cloudDeviceId: 900, cloudColumnId: 700, value: 'cloud-v2', version: 2, updatedBy: 'other', updatedAt: 't' })
    expect(r).toBe('applied')
    expect(cell(deviceId, columnId)).toMatchObject({ Value: 'cloud-v2', Version: 2 })
  })
})
