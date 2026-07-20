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
    CREATE TABLE IF NOT EXISTS PendingSyncs ( id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, TestResult TEXT, RetryCount INTEGER DEFAULT 0, LastError TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0 );
    CREATE TABLE IF NOT EXISTS SyncCursors ( SubsystemId INTEGER PRIMARY KEY, LastSeq INTEGER NOT NULL DEFAULT 0, UpdatedAt TEXT );
    CREATE TABLE IF NOT EXISTS TestHistories ( id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, Result TEXT, Timestamp TEXT );
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb, extractDeviceName: () => null }))

// Keep the mass-delete circuit breaker's audit trail out of the real logs dir.
const auditLogSpy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: auditLogSpy }))

import { applyDelta, readBroadcastUpdates } from '@/lib/cloud/delta-sync'
import { getSyncCursor } from '@/lib/cloud/sync-cursor'

const getIo = (id: number) => memDb.prepare('SELECT * FROM Ios WHERE id = ?').get(id) as any

describe('applyDelta', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM Ios; DELETE FROM PendingSyncs; DELETE FROM SyncCursors; DELETE FROM TestHistories;')
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
