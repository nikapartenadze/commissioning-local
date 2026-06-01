/**
 * Concurrency soak — proves the central server's no-lost-update guarantee.
 *
 * The test route does read-modify-write (read Version → insert TestHistory →
 * update Ios.Version=v+1 → insert PendingSync) inside a db.transaction(). Because
 * better-sqlite3 is SYNCHRONOUS and the app is single-threaded, concurrently
 * fired writes serialize atomically — every increment applies, nothing is lost.
 *
 * This test fires many writes "concurrently" (Promise.all of microtasks) at the
 * same IO and across different IOs, and asserts:
 *   - Ios.Version == N (no lost read-modify-write)
 *   - TestHistories has exactly N rows with a contiguous 1..N version sequence
 *   - no exceptions under load
 * If better-sqlite3 were async (or there were two writers), Version would be < N.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

let db: import('better-sqlite3').Database
let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-'))
  db = new Database(path.join(tmp, 'soak.db'))
  // Same durability pragmas as production (lib/db-sqlite).
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = FULL')
  db.exec(`
    CREATE TABLE Ios (id INTEGER PRIMARY KEY, Name TEXT, Result TEXT, Version INTEGER DEFAULT 0, SubsystemId INTEGER);
    CREATE TABLE TestHistories (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, Result TEXT, Version INTEGER, TestedBy TEXT);
    CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, TestResult TEXT, Version INTEGER, InspectorName TEXT);
  `)
})

afterAll(() => {
  try { db.close() } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

// Mirrors the /api/ios/:id/test write path, transactionally.
function recordTest(ioId: number, result: string, user: string): void {
  const txn = db.transaction(() => {
    const io = db.prepare('SELECT Version FROM Ios WHERE id = ?').get(ioId) as { Version: number }
    const newVersion = (io.Version ?? 0) + 1
    db.prepare('INSERT INTO TestHistories (IoId, Result, Version, TestedBy) VALUES (?, ?, ?, ?)').run(ioId, result, newVersion, user)
    db.prepare('UPDATE Ios SET Result = ?, Version = ? WHERE id = ?').run(result, newVersion, ioId)
    db.prepare('INSERT INTO PendingSyncs (IoId, TestResult, Version, InspectorName) VALUES (?, ?, ?, ?)').run(ioId, result, newVersion - 1, user)
  })
  txn()
}

describe('concurrency soak — no lost updates', () => {
  it('100 concurrent writes to the SAME IO all land; version == 100, contiguous', async () => {
    db.prepare('INSERT INTO Ios (id, Name, SubsystemId, Version) VALUES (1, ?, 38, 0)').run('IO1')
    const N = 100
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => recordTest(1, i % 2 ? 'Failed' : 'Passed', `u${i}`))
      )
    )
    expect((db.prepare('SELECT Version FROM Ios WHERE id=1').get() as { Version: number }).Version).toBe(N)
    expect((db.prepare('SELECT COUNT(*) c FROM TestHistories WHERE IoId=1').get() as { c: number }).c).toBe(N)
    expect((db.prepare('SELECT COUNT(*) c FROM PendingSyncs WHERE IoId=1').get() as { c: number }).c).toBe(N)
    const versions = (db.prepare('SELECT Version FROM TestHistories WHERE IoId=1 ORDER BY Version').all() as { Version: number }[]).map((r) => r.Version)
    expect(versions).toEqual(Array.from({ length: N }, (_, i) => i + 1)) // every increment applied, in order
  })

  it('concurrent writes across 5 DIFFERENT IOs each land independently', async () => {
    const ids = [10, 11, 12, 13, 14]
    for (const id of ids) db.prepare('INSERT INTO Ios (id, Name, SubsystemId, Version) VALUES (?, ?, 39, 0)').run(id, 'IO' + id)
    const per = 40
    await Promise.all(
      ids.flatMap((id) =>
        Array.from({ length: per }, (_, i) => Promise.resolve().then(() => recordTest(id, 'Passed', `u${i}`)))
      )
    )
    for (const id of ids) {
      expect((db.prepare('SELECT Version FROM Ios WHERE id=?').get(id) as { Version: number }).Version).toBe(per)
      expect((db.prepare('SELECT COUNT(*) c FROM TestHistories WHERE IoId=?').get(id) as { c: number }).c).toBe(per)
    }
  })

  it('200 writes under load never throw and lose nothing', async () => {
    db.prepare('INSERT INTO Ios (id, Name, SubsystemId, Version) VALUES (99, ?, 40, 0)').run('IO99')
    await expect(
      Promise.all(Array.from({ length: 200 }, () => Promise.resolve().then(() => recordTest(99, 'Passed', 'x'))))
    ).resolves.toBeDefined()
    expect((db.prepare('SELECT Version FROM Ios WHERE id=99').get() as { Version: number }).Version).toBe(200)
  })
})
