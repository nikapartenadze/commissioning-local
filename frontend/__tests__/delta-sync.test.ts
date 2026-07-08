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
      PunchlistStatus TEXT, CloudSyncedAt TEXT, "Order" INTEGER
    );
    CREATE TABLE IF NOT EXISTS PendingSyncs ( id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER );
    CREATE TABLE IF NOT EXISTS SyncCursors ( SubsystemId INTEGER PRIMARY KEY, LastSeq INTEGER NOT NULL DEFAULT 0, UpdatedAt TEXT );
    CREATE TABLE IF NOT EXISTS TestHistories ( id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, Result TEXT, Timestamp TEXT );
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb, extractDeviceName: () => null }))

import { applyDelta } from '@/lib/cloud/delta-sync'
import { getSyncCursor } from '@/lib/cloud/sync-cursor'

const getIo = (id: number) => memDb.prepare('SELECT * FROM Ios WHERE id = ?').get(id) as any

describe('applyDelta', () => {
  beforeEach(() => memDb.exec('DELETE FROM Ios; DELETE FROM PendingSyncs; DELETE FROM SyncCursors; DELETE FROM TestHistories;'))

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

  it('passes through changed section flags', () => {
    const r = applyDelta(7, { toSeq: 30, sections: { network: true, estop: false, safety: true, l2: false } })
    expect(r.sections).toEqual({ network: true, estop: false, safety: true, l2: false })
  })
})
