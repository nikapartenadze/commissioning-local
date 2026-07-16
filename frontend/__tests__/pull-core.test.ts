/**
 * Test: runFullPull — the shared destructive-pull body for the field tool's two
 * full-pull routes (/api/cloud/pull GLOBAL and /api/mcm/[id]/pull SCOPED).
 *
 * This locks the unification (2026-07 divergence fix). Before it, the scoped
 * route silently LACKED the TestHistories sync, the classifyDescription tagType
 * backfill, and the >50%-fewer-IOs warning that the legacy route had. The two
 * bodies are now one, scope-driven by `global`.
 *
 * Contract under test:
 *  - GLOBAL pull deletes the WHOLE Ios table (no WHERE) before reinserting.
 *  - SCOPED pull deletes ONLY the target subsystem's IOs — other MCMs survive.
 *  - SCOPED pull now WRITES TestHistories (scoped delete: other MCMs' audit
 *    trails survive) and BACKFILLS tagType (both previously global-only).
 *  - The >50%-fewer-IOs warning fires on both scopes.
 *  - The risk guard refuses (kind:'refuse') when the pull would erase unsynced
 *    local work and force=false.
 *  - The SCOPED in-transaction TOCTOU re-check aborts (kind:'pending-appeared')
 *    when a pending row exists; the GLOBAL path has no such re-check.
 *  - A failed pre-pull backup aborts (kind:'backup-failed') — nothing written.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3')
import { runFullPull, classifyDescription, type RunFullPullDeps } from '@/lib/cloud/pull-core'

vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})

type DB = InstanceType<typeof Database>

function makeDb(): DB {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE Projects (id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY, ProjectId INTEGER, Name TEXT);
    CREATE TABLE Ios (
      id INTEGER PRIMARY KEY, Name TEXT, Description TEXT, SubsystemId INTEGER,
      Result TEXT, Comments TEXT, Timestamp TEXT, TestedBy TEXT, IoNumber INTEGER,
      InstallationStatus TEXT, InstallationPercent INTEGER, PoweredUp INTEGER,
      TagType TEXT, Version INTEGER, Trade TEXT, ClarificationNote TEXT,
      NetworkDeviceName TEXT, PunchlistStatus TEXT, CloudSyncedAt TEXT, "Order" INTEGER
    , CloudRemoved INTEGER DEFAULT 0);
    CREATE TABLE TestHistories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, Result TEXT, TestedBy TEXT,
      Comments TEXT, FailureMode TEXT, State TEXT, Timestamp TEXT, Source TEXT
    );
    CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, DeadLettered INTEGER DEFAULT 0);
    CREATE TABLE EStopCheckPendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER);
    CREATE TABLE GuidedTaskStatePendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER);
    -- Tables touched only by the GLOBAL stale-config cleanup:
    CREATE TABLE EStopZones (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER);
    CREATE TABLE EStopEpcs (id INTEGER PRIMARY KEY AUTOINCREMENT, ZoneId INTEGER);
    CREATE TABLE EStopIoPoints (id INTEGER PRIMARY KEY AUTOINCREMENT, EpcId INTEGER);
    CREATE TABLE EStopVfds (id INTEGER PRIMARY KEY AUTOINCREMENT, EpcId INTEGER);
    CREATE TABLE SafetyZones (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER);
    CREATE TABLE SafetyZoneDrives (id INTEGER PRIMARY KEY AUTOINCREMENT, ZoneId INTEGER);
    CREATE TABLE SafetyOutputs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER);
    CREATE TABLE NetworkRings (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER);
    CREATE TABLE NetworkNodes (id INTEGER PRIMARY KEY AUTOINCREMENT, RingId INTEGER);
    CREATE TABLE NetworkPorts (id INTEGER PRIMARY KEY AUTOINCREMENT, NodeId INTEGER);
    CREATE TABLE Punchlists (id INTEGER PRIMARY KEY, SubsystemId INTEGER);
    CREATE TABLE PunchlistItems (id INTEGER PRIMARY KEY AUTOINCREMENT, PunchlistId INTEGER);
  `)
  return db
}

function seedIo(db: DB, id: number, subsystemId: number, extra: Partial<{ Name: string; Result: string; Description: string; TagType: string; Timestamp: string }> = {}) {
  db.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result, Description, TagType, Timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, extra.Name ?? `IO_${id}`, subsystemId, extra.Result ?? null, extra.Description ?? null, extra.TagType ?? null, extra.Timestamp ?? null)
}

function makeDeps(overrides: Partial<RunFullPullDeps> = {}): RunFullPullDeps {
  return {
    createBackup: vi.fn(async () => ({ filename: 'test-backup.db' })),
    extractDeviceName: vi.fn(() => null),
    pullL2: vi.fn(async () => ({ l2Pulled: 0, l2CellsPulled: 0, l2Error: null })),
    runConfigSidePulls: vi.fn(async () => ({ networkPulled: 0, estopPulled: 0, safetyPulled: 0, punchlistsPulled: 0, guidedTaskStatesPulled: 0 })),
    ...overrides,
  }
}

const cloudIo = (id: number, over: Record<string, unknown> = {}) => ({ id, name: `IO_${id}`, result: null, version: 1, ...over })

const base = {
  cloudHistories: [],
  remoteUrl: 'http://cloud',
  apiPassword: 'key',
  force: false,
  logPrefix: '[test]',
}

describe('runFullPull — scope-correct DELETE', () => {
  let db: DB
  beforeEach(() => { db = makeDb() })

  it('SCOPED pull deletes only the target subsystem — other MCMs survive', async () => {
    seedIo(db, 1, 16)
    seedIo(db, 2, 16)
    seedIo(db, 100, 99) // another MCM's IO — must survive
    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: [cloudIo(1), cloudIo(3)], // 2 dropped, 3 added
      ...base, deps: makeDeps(),
    })
    expect(res.kind).toBe('ok')
    const ids16 = db.prepare('SELECT id FROM Ios WHERE SubsystemId = 16 ORDER BY id').all().map((r: any) => r.id)
    expect(ids16).toEqual([1, 3])
    // Other MCM untouched.
    expect(db.prepare('SELECT COUNT(*) c FROM Ios WHERE SubsystemId = 99').get().c).toBe(1)
  })

  it('GLOBAL pull deletes the WHOLE Ios table before reinserting', async () => {
    seedIo(db, 1, 16)
    seedIo(db, 100, 99) // in GLOBAL (single-MCM) mode this whole table is replaced
    const res = await runFullPull({
      db, subsystemId: 16, global: true,
      cloudIos: [cloudIo(1)],
      ...base, deps: makeDeps(),
    })
    expect(res.kind).toBe('ok')
    // 99's leftover row is gone (global wipe); only the cloud row remains.
    const all = db.prepare('SELECT id, SubsystemId FROM Ios ORDER BY id').all()
    expect(all).toEqual([{ id: 1, SubsystemId: 16 }])
  })
})

describe('runFullPull — scoped pull GAINS TestHistories + tagType backfill', () => {
  let db: DB
  beforeEach(() => { db = makeDb() })

  it('writes TestHistories on a SCOPED pull, scoped-deleting only this subsystem', async () => {
    seedIo(db, 1, 16)
    seedIo(db, 100, 99)
    // Pre-existing history for the OTHER MCM must survive the scoped delete.
    db.prepare('INSERT INTO TestHistories (IoId, Result, Timestamp, Source) VALUES (100, ?, ?, ?)').run('Passed', '2026-01-01T00:00:00Z', 'local')
    // Stale history for THIS MCM's IO should be cleared and replaced by cloud.
    db.prepare('INSERT INTO TestHistories (IoId, Result, Timestamp, Source) VALUES (1, ?, ?, ?)').run('Stale', '2026-01-01T00:00:00Z', 'local')

    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: [cloudIo(1)],
      cloudHistories: [{ ioId: 1, result: 'Passed', timestamp: '2026-07-01T00:00:00Z', source: 'cloud' }],
      remoteUrl: 'http://cloud', apiPassword: 'key', force: false, logPrefix: '[test]',
      deps: makeDeps(),
    })
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.historiesPulled).toBe(1)
    // Other MCM's history survived (scoped TestHistories delete).
    expect(db.prepare("SELECT COUNT(*) c FROM TestHistories WHERE IoId = 100").get().c).toBe(1)
    // This MCM's stale history was replaced by the cloud one.
    const h16 = db.prepare('SELECT Result, Source FROM TestHistories WHERE IoId = 1').all()
    expect(h16).toEqual([{ Result: 'Passed', Source: 'cloud' }])
  })

  it('backfills tagType from description on a SCOPED pull', async () => {
    // Cloud sends the IO with a beacon description but no tagType.
    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: [cloudIo(1, { description: 'Aisle Beacon strobe', tagType: null })],
      ...base, deps: makeDeps(),
    })
    expect(res.kind).toBe('ok')
    const tag = db.prepare('SELECT TagType FROM Ios WHERE id = 1').get().TagType
    expect(tag).toBe(classifyDescription('Aisle Beacon strobe'))
    expect(tag).toBe('BCN 24V Segment 1')
  })

  it('GLOBAL pull wipes ALL TestHistories (single-MCM semantics)', async () => {
    seedIo(db, 1, 16)
    db.prepare('INSERT INTO TestHistories (IoId, Result, Timestamp, Source) VALUES (999, ?, ?, ?)').run('Old', '2026-01-01T00:00:00Z', 'local')
    const res = await runFullPull({
      db, subsystemId: 16, global: true,
      cloudIos: [cloudIo(1)],
      cloudHistories: [{ ioId: 1, result: 'Passed', timestamp: '2026-07-01T00:00:00Z', source: 'cloud' }],
      remoteUrl: 'http://cloud', apiPassword: 'key', force: false, logPrefix: '[test]',
      deps: makeDeps(),
    })
    expect(res.kind).toBe('ok')
    // The orphan history (IoId 999) is gone — global unscoped delete.
    expect(db.prepare('SELECT COUNT(*) c FROM TestHistories WHERE IoId = 999').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM TestHistories WHERE IoId = 1').get().c).toBe(1)
  })
})

describe('runFullPull — >50%-fewer-IOs warning (both scopes)', () => {
  let db: DB
  beforeEach(() => { db = makeDb() })

  it('sets pullWarning when the cloud returns >50% fewer IOs (scoped)', async () => {
    for (let i = 1; i <= 10; i++) seedIo(db, i, 16)
    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: [cloudIo(1), cloudIo(2)], // 2 vs 10 local → 80% fewer
      ...base, deps: makeDeps(),
    })
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.pullWarning).toMatch(/80% fewer/)
  })

  it('no warning when the reduction is under 50% (scoped)', async () => {
    for (let i = 1; i <= 10; i++) seedIo(db, i, 16)
    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: Array.from({ length: 8 }, (_, i) => cloudIo(i + 1)),
      ...base, deps: makeDeps(),
    })
    expect(res.kind).toBe('ok')
    if (res.kind !== 'ok') return
    expect(res.pullWarning).toBeUndefined()
  })
})

describe('runFullPull — guards preserved', () => {
  let db: DB
  beforeEach(() => { db = makeDb() })

  it('refuses (kind:refuse) when the pull would erase an unsynced local result', async () => {
    // Local has a Passed the cloud payload lacks → the MCM08 at-risk shape.
    seedIo(db, 1, 16, { Result: 'Passed' })
    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: [cloudIo(1, { result: null })],
      ...base, deps: makeDeps(),
    })
    expect(res.kind).toBe('refuse')
    if (res.kind !== 'refuse') return
    expect(res.status).toBe(409)
    expect(res.body.requiresForce).toBe(true)
    // The Passed local result is still there — nothing destructive ran.
    expect(db.prepare('SELECT Result FROM Ios WHERE id = 1').get().Result).toBe('Passed')
  })

  it('force=true overrides the refuse and applies the pull', async () => {
    seedIo(db, 1, 16, { Result: 'Passed' })
    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: [cloudIo(1, { result: null })],
      cloudHistories: [], remoteUrl: 'http://cloud', apiPassword: 'key', force: true, logPrefix: '[test]',
      deps: makeDeps(),
    })
    expect(res.kind).toBe('ok')
  })

  it('SCOPED path aborts (kind:pending-appeared) when a pending row exists for the subsystem', async () => {
    // Cloud carries the SAME result so the risk guard passes; the TOCTOU
    // re-check inside the transaction is what must fire on the pending row.
    seedIo(db, 1, 16, { Result: 'Passed' })
    db.prepare('INSERT INTO PendingSyncs (IoId) VALUES (1)').run()
    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: [cloudIo(1, { result: 'Passed' })],
      ...base, deps: makeDeps(),
    })
    expect(res.kind).toBe('pending-appeared')
    // Local row untouched (transaction rolled back).
    expect(db.prepare('SELECT COUNT(*) c FROM Ios WHERE SubsystemId = 16').get().c).toBe(1)
  })

  it('GLOBAL path has NO TOCTOU re-check — a pending row does not abort it', async () => {
    seedIo(db, 1, 16, { Result: 'Passed' })
    db.prepare('INSERT INTO PendingSyncs (IoId) VALUES (1)').run()
    const res = await runFullPull({
      db, subsystemId: 16, global: true,
      cloudIos: [cloudIo(1, { result: 'Passed' })],
      ...base, deps: makeDeps(),
    })
    expect(res.kind).toBe('ok')
  })

  it('aborts (kind:backup-failed) and writes nothing when the pre-pull backup fails', async () => {
    seedIo(db, 1, 16)
    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: [cloudIo(2)],
      ...base,
      deps: makeDeps({ createBackup: vi.fn(async () => { throw new Error('disk full') }) }),
    })
    expect(res.kind).toBe('backup-failed')
    // The original IO is still present — no delete ran.
    expect(db.prepare('SELECT COUNT(*) c FROM Ios WHERE id = 1').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM Ios WHERE id = 2').get().c).toBe(0)
  })

  it('backfills NetworkDeviceName via the injected extractDeviceName (scoped filter)', async () => {
    const res = await runFullPull({
      db, subsystemId: 16, global: false,
      cloudIos: [cloudIo(1, { name: 'MCM16_Belt01_Motor' })],
      ...base,
      deps: makeDeps({ extractDeviceName: vi.fn((n: string) => n.split('_')[1] ?? null) }),
    })
    expect(res.kind).toBe('ok')
    expect(db.prepare('SELECT NetworkDeviceName FROM Ios WHERE id = 1').get().NetworkDeviceName).toBe('Belt01')
  })
})
