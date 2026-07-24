import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory DB with the columns applyDelta's upsert touches (subset of the real
// Ios schema) + PendingSyncs + SyncCursors. Never touches the real db file.
const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE IF NOT EXISTS Ios (
      id INTEGER PRIMARY KEY, Name TEXT, Description TEXT, SubsystemId INTEGER,
      Result TEXT, Comments TEXT, Timestamp TEXT, TestedBy TEXT, IoNumber INTEGER,
      InstallationStatus TEXT, InstallationPercent REAL, PoweredUp INTEGER, TagType TEXT,
      Version INTEGER DEFAULT 0, Trade TEXT, ClarificationNote TEXT, NetworkDeviceName TEXT,
      PunchlistStatus TEXT, PlannedDate TEXT, CloudSyncedAt TEXT, "Order" INTEGER
    , CloudRemoved INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS PendingSyncs ( id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, TestResult TEXT, RetryCount INTEGER DEFAULT 0, LastError TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0 , Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE IF NOT EXISTS SyncCursors ( SubsystemId INTEGER PRIMARY KEY, LastSeq INTEGER NOT NULL DEFAULT 0, UpdatedAt TEXT );
    CREATE TABLE IF NOT EXISTS TestHistories ( id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, Result TEXT, Timestamp TEXT );
    CREATE TABLE IF NOT EXISTS Subsystems ( id INTEGER PRIMARY KEY, ProjectId INTEGER, Name TEXT );
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb, extractDeviceName: () => null }))

// Keep the mass-delete circuit breaker's audit trail out of the real logs dir.
const auditLogSpy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: auditLogSpy }))

import {
  applyDelta,
  readBroadcastUpdates,
  extractSubsystemEvents,
  fetchAndApplyDelta,
  __resetSubsystemsCloudRemovedMemo,
  type DeltaPayload,
} from '@/lib/cloud/delta-sync'
import { getSyncCursor } from '@/lib/cloud/sync-cursor'

const getIo = (id: number) => memDb.prepare('SELECT * FROM Ios WHERE id = ?').get(id) as any

describe('applyDelta', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM Ios; DELETE FROM PendingSyncs; DELETE FROM SyncCursors; DELETE FROM TestHistories; DELETE FROM Subsystems;')
    auditLogSpy.mockClear()
  })

  it('does NOT revert a deliberate recent clear with a stale cloud result (MCM04 reset loop)', () => {
    // Operator cleared it locally (Result NULL) with a 'Cleared' history at 07-07.
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result, Timestamp) VALUES (?, ?, ?, NULL, NULL)').run(64108, 'PS6_15_VFD:O.IO_0', 40)
    memDb.prepare('INSERT INTO TestHistories (IoId, Result, Timestamp) VALUES (?, ?, ?)').run(64108, 'Cleared', '2026-07-07 18:27:00')
    // Cloud still holds the stale higher-versioned Passed from 07-04.
    applyDelta(40, { toSeq: 20, ios: { upserts: [{ id: 64108, name: 'PS6_15_VFD:O.IO_0', result: 'Passed', timestamp: '2026-07-04T20:45:00.000Z', version: 19 }] } })
    const io = getIo(64108)
    expect(io.Result).toBeNull() // clear preserved — NOT reverted to Passed
    expect(io.Version).toBe(19) // definition/version still refreshed
  })

  it('DOES apply a cloud result that is provably newer than the clear', () => {
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result) VALUES (?, ?, ?, NULL)').run(200, 'IO-Z', 40)
    memDb.prepare('INSERT INTO TestHistories (IoId, Result, Timestamp) VALUES (?, ?, ?)').run(200, 'Cleared', '2026-07-04T10:00:00.000Z')
    applyDelta(40, { toSeq: 21, ios: { upserts: [{ id: 200, name: 'IO-Z', result: 'Passed', timestamp: '2026-07-07T10:00:00.000Z' }] } })
    expect(getIo(200).Result).toBe('Passed') // real later cloud edit wins
  })

  it('BUG D FIX: broadcast carries the DB-FINAL value, not the raw cloud payload', () => {
    // Protected-clear: local cleared (NULL); cloud still holds a stale, higher-
    // versioned Passed → applyDelta KEEPS the clear.
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result, Timestamp) VALUES (?, ?, ?, NULL, NULL)').run(300, 'IO-CLR', 40)
    memDb.prepare('INSERT INTO TestHistories (IoId, Result, Timestamp) VALUES (?, ?, ?)').run(300, 'Cleared', '2026-07-07 18:00:00')
    // A normally-applied IO (cloud result lands).
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result) VALUES (?, ?, ?, NULL)').run(301, 'IO-OK', 40)
    applyDelta(40, { toSeq: 30, ios: { upserts: [
      { id: 300, name: 'IO-CLR', result: 'Passed', timestamp: '2026-07-04T20:45:00.000Z', version: 19 }, // stale → clear kept
      { id: 301, name: 'IO-OK', result: 'Failed', timestamp: '2026-07-07T10:00:00.000Z' },               // applied
    ] } })
    // DB truth after apply.
    expect(getIo(300).Result).toBeNull()
    expect(getIo(301).Result).toBe('Failed')
    // The broadcast MUST reflect the DB, not the payload: the protected-clear
    // broadcasts 'Not Tested' (NOT the cloud's 'Passed' — that was the live-grid
    // lie), and the applied one broadcasts its real 'Failed'.
    const byId = new Map(readBroadcastUpdates([300, 301]).map(u => [u.id, u]))
    expect(byId.get(300)!.result).toBe('Not Tested') // NOT 'Passed'
    expect(byId.get(301)!.result).toBe('Failed')
  })

  it('readBroadcastUpdates skips ids not in Ios and chunks large id sets (>500)', () => {
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result) VALUES (?, ?, ?, ?)').run(400, 'IO-A', 40, 'Passed')
    const many = Array.from({ length: 1200 }, (_, i) => 10_000 + i) // none exist
    const updates = readBroadcastUpdates([400, ...many])
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ id: 400, result: 'Passed' })
  })

  // ── Resolver-field (punchlist) propagation ─────────────────────────────────
  it('applies a cloud punchlist SET (ADDRESSED) on pull', () => {
    memDb.prepare("INSERT INTO Ios (id, Name, SubsystemId, Result) VALUES (?, ?, ?, 'Failed')").run(302, 'IO-R', 40)
    applyDelta(40, { toSeq: 32, ios: { upserts: [{ id: 302, name: 'IO-R', result: 'Failed', punchlistStatus: 'ADDRESSED' }] } })
    expect(getIo(302).PunchlistStatus).toBe('ADDRESSED')
  })

  it('applies a cloud punchlist CLEAR (null) when no local punchlist edit is pending', () => {
    // Regression: a cloud un-address used to never reach the tablet on pull —
    // the merge coalesced null→keep-local. Now it clears (no pending guard hit).
    memDb.prepare("INSERT INTO Ios (id, Name, SubsystemId, Result, PunchlistStatus) VALUES (?, ?, ?, 'Failed', 'ADDRESSED')").run(300, 'IO-P', 40)
    applyDelta(40, { toSeq: 30, ios: { upserts: [{ id: 300, name: 'IO-P', result: 'Failed', punchlistStatus: null }] } })
    expect(getIo(300).PunchlistStatus).toBeNull()
  })

  it('keeps a pending local punchlist edit against a cloud clear until it syncs', () => {
    memDb.prepare("INSERT INTO Ios (id, Name, SubsystemId, Result, PunchlistStatus) VALUES (?, ?, ?, 'Failed', 'ADDRESSED')").run(301, 'IO-Q', 40)
    memDb.prepare("INSERT INTO PendingSyncs (IoId, TestResult) VALUES (?, 'Punchlist Updated')").run(301)
    applyDelta(40, { toSeq: 31, ios: { upserts: [{ id: 301, name: 'IO-Q', result: 'Failed', punchlistStatus: null }] } })
    expect(getIo(301).PunchlistStatus).toBe('ADDRESSED') // un-pushed local edit protected
  })

  // ── Planned-date propagation (cloud-owned, field read-only) ────────────────
  it('applies a cloud plannedDate on delta and a cloud null CLEARS it (direct set)', () => {
    memDb.prepare("INSERT INTO Ios (id, Name, SubsystemId, PlannedDate) VALUES (?, ?, ?, '2026-07-01')").run(310, 'IO-PD', 40)
    applyDelta(40, { toSeq: 33, ios: { upserts: [{ id: 310, name: 'IO-PD', plannedDate: '2026-08-03' }] } })
    expect(getIo(310).PlannedDate).toBe('2026-08-03')
    // Cloud unschedules → cleared, even though a local value exists. The field
    // never edits plannedDate, so unlike Result there is nothing to protect.
    applyDelta(40, { toSeq: 34, ios: { upserts: [{ id: 310, name: 'IO-PD', plannedDate: null }] } })
    expect(getIo(310).PlannedDate).toBeNull()
  })

  it('keep-clear variant still applies plannedDate while preserving the local clear', () => {
    // Protected clear: local Result NULL with a recent 'Cleared' history; cloud
    // carries a stale result → Result stays cleared, but the cloud-owned
    // plannedDate (a definition-class field) must still land.
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result, Timestamp) VALUES (?, ?, ?, NULL, NULL)').run(311, 'IO-PDC', 40)
    memDb.prepare('INSERT INTO TestHistories (IoId, Result, Timestamp) VALUES (?, ?, ?)').run(311, 'Cleared', '2026-07-07 18:00:00')
    applyDelta(40, { toSeq: 35, ios: { upserts: [{ id: 311, name: 'IO-PDC', result: 'Passed', timestamp: '2026-07-04T20:45:00.000Z', plannedDate: '2026-08-05' }] } })
    const io = getIo(311)
    expect(io.Result).toBeNull() // clear preserved
    expect(io.PlannedDate).toBe('2026-08-05') // schedule applied anyway
  })

  it('restores a cloud result over a never-tested (non-deliberate) null IO', () => {
    // No 'Cleared' history → this null is "never tested", not a deliberate clear.
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result) VALUES (?, ?, ?, NULL)').run(201, 'IO-Y', 40)
    applyDelta(40, { toSeq: 22, ios: { upserts: [{ id: 201, name: 'IO-Y', result: 'Passed', timestamp: '2026-07-04T10:00:00.000Z' }] } })
    expect(getIo(201).Result).toBe('Passed')
  })

  it('inserts a new IO from an upsert', () => {
    const r = applyDelta(7, { toSeq: 10, ios: { upserts: [{ id: 100, name: 'IO-A', result: 'Passed' }] } })
    expect(r.applied).toBe(1)
    expect(getIo(100).Name).toBe('IO-A')
  })

  it('preserves a local un-pushed Result while updating the definition', () => {
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result) VALUES (?, ?, ?, ?)').run(101, 'old-name', 7, 'Failed')
    applyDelta(7, { toSeq: 11, ios: { upserts: [{ id: 101, name: 'new-name', result: 'Passed' }] } })
    const io = getIo(101)
    expect(io.Name).toBe('new-name') // cloud owns the definition
    expect(io.Result).toBe('Failed') // local result authority preserved
  })

  it('deletes a removed IO that has no un-pushed local work', () => {
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId) VALUES (?, ?, ?)').run(5, 'gone', 7)
    const r = applyDelta(7, { toSeq: 12, ios: { deletes: [5] } })
    expect(r.deleted).toBe(1)
    expect(getIo(5)).toBeUndefined()
  })

  it('GUARDS a cloud-deleted IO that still has an un-pushed result', () => {
    memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result) VALUES (?, ?, ?, ?)').run(6, 'tested', 7, 'Failed')
    memDb.prepare('INSERT INTO PendingSyncs (IoId) VALUES (?)').run(6)
    const r = applyDelta(7, { toSeq: 13, ios: { deletes: [6] } })
    expect(r.deleted).toBe(0)
    expect(r.skippedDeletes).toEqual([6])
    expect(getIo(6)).toBeDefined() // row kept — local work not dropped
  })

  it('advances the cursor to toSeq', () => {
    applyDelta(7, { toSeq: 42, ios: { upserts: [{ id: 1, name: 'x' }] } })
    expect(getSyncCursor(7)).toBe(42)
  })

  it('returns resync and leaves the cursor untouched on a resync payload', () => {
    memDb.prepare('INSERT INTO SyncCursors (SubsystemId, LastSeq) VALUES (?, ?)').run(7, 10)
    const r = applyDelta(7, { resync: true, toSeq: 99 })
    expect(r.resync).toBe(true)
    expect(getSyncCursor(7)).toBe(10)
  })

  it('is idempotent — re-applying the same delta is a no-op on results', () => {
    const payload = { toSeq: 20, ios: { upserts: [{ id: 1, name: 'n', result: 'Passed' }] } }
    applyDelta(7, payload)
    // a local result lands between applies
    memDb.prepare('UPDATE Ios SET Result = ? WHERE id = ?').run('Failed', 1)
    applyDelta(7, payload)
    expect(getIo(1).Result).toBe('Failed') // re-apply doesn't clobber local
  })

  it('BLOCKS a mass delete (>50) but still applies upserts and advances the cursor', () => {
    const insert = memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId) VALUES (?, ?, ?)')
    const ids: number[] = []
    for (let i = 1; i <= 51; i++) { insert.run(i, `IO-${i}`, 7); ids.push(i) }
    const r = applyDelta(7, {
      toSeq: 50,
      ios: { upserts: [{ id: 500, name: 'IO-NEW', result: 'Passed' }], deletes: ids },
    })
    // No deletes applied — all 51 rows survive.
    expect(r.deleted).toBe(0)
    expect(r.massDeleteBlocked).toBe(51)
    expect((memDb.prepare('SELECT COUNT(*) AS c FROM Ios WHERE id <= 51').get() as any).c).toBe(51)
    // Upsert still landed and the cursor still advanced (breaker must not wedge sync).
    expect(r.applied).toBe(1)
    expect(getIo(500).Name).toBe('IO-NEW')
    expect(getSyncCursor(7)).toBe(50)
    // Durable audit trail of the blocked bulk delete.
    expect(auditLogSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sync.pull',
      detail: expect.objectContaining({ route: 'delta', massDeleteBlocked: 51, subsystemId: 7 }),
    }))
  })

  it('applies deletes normally at exactly the 50-row limit (per-row guards intact)', () => {
    const insert = memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId) VALUES (?, ?, ?)')
    const ids: number[] = []
    for (let i = 1; i <= 50; i++) { insert.run(i, `IO-${i}`, 7); ids.push(i) }
    // One of them still holds un-pushed local work — the per-row guard keeps it.
    memDb.prepare('INSERT INTO PendingSyncs (IoId) VALUES (?)').run(50)
    const r = applyDelta(7, { toSeq: 51, ios: { deletes: ids } })
    expect(r.massDeleteBlocked).toBeUndefined()
    expect(r.deleted).toBe(49)
    expect(r.skippedDeletes).toEqual([50])
    expect(getIo(50)).toBeDefined()
    expect(auditLogSpy).not.toHaveBeenCalled()
  })

  it('passes through changed section flags', () => {
    const r = applyDelta(7, { toSeq: 30, sections: { network: true, estop: false, safety: true, l2: false } })
    expect(r.sections).toEqual({ network: true, estop: false, safety: true, l2: false })
  })
})

// ── caps=subsystem rename/delete entries (contract 2026-07-24) ───────────────
describe('subsystem change entries', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM Ios; DELETE FROM PendingSyncs; DELETE FROM SyncCursors; DELETE FROM TestHistories; DELETE FROM Subsystems;')
    auditLogSpy.mockClear()
    __resetSubsystemsCloudRemovedMemo()
  })

  const seedSubsystem = (id: number, name = 'MCM07') =>
    memDb.prepare('INSERT INTO Subsystems (id, ProjectId, Name) VALUES (?, 1, ?)').run(id, name)

  it('extractSubsystemEvents reads the top-level `subsystems` array and skips unknown entityTypes', () => {
    const payload = {
      toSeq: 5,
      subsystems: [
        { entityType: 'subsystem', op: 'renamed', subsystemId: 7, name: 'MCM07-B' },
        { entityType: 'subsystem', op: 'deleted', subsystemId: 8 },
        { entityType: 'martian_probe', op: 'landed', entityId: '9' }, // unknown → skipped
        { seq: 3, entityType: 'io', entityId: '1', op: 'update' },    // io rows ride ios.upserts, not this path
      ],
    } as DeltaPayload
    const events = extractSubsystemEvents(payload)
    expect(events).toEqual([
      { entityType: 'subsystem', op: 'renamed', subsystemId: 7, name: 'MCM07-B' },
      { entityType: 'subsystem', op: 'deleted', subsystemId: 8, name: null },
    ])
    // entries must live in `subsystems` — other keys are NOT scanned
    expect(extractSubsystemEvents({
      toSeq: 5,
      changes: [{ entityType: 'subsystem', op: 'deleted', subsystemId: 8 }],
    } as unknown as DeltaPayload)).toEqual([])
  })

  it("'renamed' updates the local Subsystems.Name and reports it in the result", () => {
    seedSubsystem(7, 'MCM07')
    const r = applyDelta(7, {
      toSeq: 10,
      subsystems: [{ entityType: 'subsystem', op: 'renamed', subsystemId: 7, name: 'MCM07 East Wing' }],
    } as DeltaPayload)
    expect((memDb.prepare('SELECT Name FROM Subsystems WHERE id = 7').get() as any).Name).toBe('MCM07 East Wing')
    expect(r.subsystemRenames).toEqual([{ subsystemId: 7, name: 'MCM07 East Wing' }])
    expect(getSyncCursor(7)).toBe(10)
    expect(auditLogSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'sync.subsystem.renamed', subsystemId: 7 }))
  })

  it("'renamed' with an empty name is a safe no-op", () => {
    seedSubsystem(7, 'MCM07')
    const r = applyDelta(7, {
      toSeq: 11,
      subsystems: [{ entityType: 'subsystem', op: 'renamed', subsystemId: 7, name: '  ' }],
    } as DeltaPayload)
    expect((memDb.prepare('SELECT Name FROM Subsystems WHERE id = 7').get() as any).Name).toBe('MCM07')
    expect(r.subsystemRenames).toBeUndefined()
  })

  it('ROUTING: entries apply by PAYLOAD subsystemId — a sibling feed carries another subsystem\'s tombstone', () => {
    // Polling MCM 7's feed; the delete tombstone targets sibling 8 (the deleted
    // subsystem's own feed is cascade-wiped / 403s — sibling fan-out by design).
    seedSubsystem(7, 'MCM07')
    seedSubsystem(8, 'MCM08')
    const r = applyDelta(7, {
      toSeq: 12,
      subsystems: [{ entityType: 'subsystem', op: 'deleted', subsystemId: 8 }],
    } as DeltaPayload)
    const sub7 = memDb.prepare('SELECT * FROM Subsystems WHERE id = 7').get() as any
    const sub8 = memDb.prepare('SELECT * FROM Subsystems WHERE id = 8').get() as any
    expect(sub7.CloudRemoved ?? 0).toBe(0) // the POLLED subsystem is untouched
    expect(sub8.CloudRemoved).toBe(1)      // the PAYLOAD subsystem is tombstoned
    expect(r.subsystemCloudRemoved).toEqual([8])
    expect(auditLogSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'sync.subsystem.cloud-removed', subsystemId: 8 }))
  })

  it("'deleted' NEVER deletes local data — it sets the CloudRemoved tombstone and audits", () => {
    seedSubsystem(7, 'MCM07')
    memDb.prepare("INSERT INTO Ios (id, Name, SubsystemId, Result) VALUES (1, 'IO-A', 7, 'Passed')").run()
    memDb.prepare("INSERT INTO Ios (id, Name, SubsystemId, Result) VALUES (2, 'IO-B', 7, 'Failed')").run()

    const r = applyDelta(7, {
      toSeq: 13,
      subsystems: [{ entityType: 'subsystem', op: 'deleted', subsystemId: 7 }],
    } as DeltaPayload)

    // Subsystem row + every IO + every result survive verbatim.
    const sub = memDb.prepare('SELECT * FROM Subsystems WHERE id = 7').get() as any
    expect(sub).toBeDefined()
    expect(sub.Name).toBe('MCM07')
    expect(sub.CloudRemoved).toBe(1) // tombstone set (column lazily added)
    expect(getIo(1).Result).toBe('Passed')
    expect(getIo(2).Result).toBe('Failed')
    expect(r.subsystemCloudRemoved).toEqual([7])
    expect(getSyncCursor(7)).toBe(13)
    expect(auditLogSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'sync.subsystem.cloud-removed', subsystemId: 7 }))
  })

  it("'deleted' is idempotent — re-applying the same window changes nothing", () => {
    seedSubsystem(7)
    const payload = { toSeq: 14, subsystems: [{ entityType: 'subsystem', op: 'deleted', subsystemId: 7 }] } as DeltaPayload
    applyDelta(7, payload)
    applyDelta(7, payload)
    expect((memDb.prepare('SELECT CloudRemoved FROM Subsystems WHERE id = 7').get() as any).CloudRemoved).toBe(1)
    expect(memDb.prepare('SELECT COUNT(*) AS c FROM Subsystems').get() as any).toMatchObject({ c: 1 })
  })

  it('an unknown subsystem op is skipped without failing the batch', () => {
    seedSubsystem(7, 'MCM07')
    const r = applyDelta(7, {
      toSeq: 15,
      ios: { upserts: [{ id: 100, name: 'IO-NEW', result: 'Passed' }] },
      subsystems: [{ entityType: 'subsystem', op: 'archived', subsystemId: 7 }],
    } as DeltaPayload)
    // Batch unaffected: upsert landed, cursor advanced, name untouched.
    expect(r.applied).toBe(1)
    expect(getIo(100).Result).toBe('Passed')
    expect(getSyncCursor(7)).toBe(15)
    expect((memDb.prepare('SELECT Name FROM Subsystems WHERE id = 7').get() as any).Name).toBe('MCM07')
  })

  it('unknown entityType entries never fail the batch/transaction (fleet forward-compat)', () => {
    const r = applyDelta(7, {
      toSeq: 16,
      ios: { upserts: [{ id: 101, name: 'IO-X', result: 'Failed' }] },
      subsystems: [
        { entityType: 'hologram', op: 'projected', entityId: '3' },
        'not-even-an-object',
        null,
        { op: 'renamed', subsystemId: 7, name: 'no-entity-type' }, // untagged → ignored
      ],
    } as unknown as DeltaPayload)
    expect(r.applied).toBe(1)
    expect(getIo(101).Result).toBe('Failed')
    expect(getSyncCursor(7)).toBe(16)
  })

  it('a resync payload with an EMPTY subsystems array is a clean no-op for subsystem state', () => {
    seedSubsystem(7, 'MCM07')
    const r = applyDelta(7, { resync: true, toSeq: 99, subsystems: [] } as DeltaPayload)
    expect(r.resync).toBe(true)
    expect(r.subsystemRenames).toBeUndefined()
    expect(r.subsystemCloudRemoved).toBeUndefined()
    expect((memDb.prepare('SELECT Name FROM Subsystems WHERE id = 7').get() as any).Name).toBe('MCM07')
  })

  it('tolerates a database without the Subsystems row (rename/delete are no-ops, batch survives)', () => {
    // No Subsystems row seeded at all.
    const r = applyDelta(7, {
      toSeq: 17,
      ios: { upserts: [{ id: 102, name: 'IO-Y' }] },
      subsystems: [
        { entityType: 'subsystem', op: 'renamed', subsystemId: 7, name: 'Ghost' },
        { entityType: 'subsystem', op: 'deleted', subsystemId: 7 },
      ],
    } as DeltaPayload)
    expect(r.applied).toBe(1)
    expect(getSyncCursor(7)).toBe(17)
  })
})

// ── caps opt-in on the /changes request ──────────────────────────────────────
describe('fetchAndApplyDelta caps opt-in', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM Ios; DELETE FROM PendingSyncs; DELETE FROM SyncCursors; DELETE FROM TestHistories; DELETE FROM Subsystems;')
    auditLogSpy.mockClear()
  })

  it('requests /changes with caps=subsystem (comma-separable opt-in list)', async () => {
    memDb.prepare('INSERT INTO SyncCursors (SubsystemId, LastSeq) VALUES (7, 41)').run()
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ resync: false, toSeq: 42, ios: { upserts: [], deletes: [] } }),
    }))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const r = await fetchAndApplyDelta(7, { remoteUrl: 'http://cloud.example', apiPassword: 'k' })
      expect(r.toSeq).toBe(42)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const url = String((fetchSpy.mock.calls[0] as unknown[])[0])
      expect(url).toBe('http://cloud.example/api/sync/subsystem/7/changes?since=41&caps=subsystem')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
