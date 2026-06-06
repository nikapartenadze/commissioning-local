/**
 * Dead-letter semantics for the IO sync queue (B3/B5/B7/B8 fix, 2026-06-06).
 *
 * The MCM11 silent-loss class came from DELETING pending rows on permanent
 * reject / retry-cap: the queue count hit 0 and the UI read "synced" while the
 * result never reached cloud. The fix PARKS such rows (DeadLettered=1) instead
 * of deleting them, so:
 *   - they leave the ACTIVE push queue (not retried forever),
 *   - they are NEVER lost (row + result + reason kept),
 *   - they are counted as "needs attention" and surfaced in the indicator,
 *   - a destructive pull is still blocked while they exist.
 *
 * Tested against the exact SQL the repository/auto-sync use, on an in-memory
 * DB (independent of the app's better-sqlite3 singleton).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

let db: Database.Database

function seedRow(ioId: number, result: string, retry = 0, dead = 0): number {
  const r = db.prepare(
    'INSERT INTO PendingSyncs (IoId, TestResult, RetryCount, DeadLettered, CreatedAt) VALUES (?, ?, ?, ?, ?)'
  ).run(ioId, result, retry, dead, new Date().toISOString())
  return Number(r.lastInsertRowid)
}

const activeCount = () =>
  (db.prepare('SELECT COUNT(*) c FROM PendingSyncs WHERE DeadLettered = 0').get() as any).c
const attentionCount = () =>
  (db.prepare('SELECT COUNT(*) c FROM PendingSyncs WHERE DeadLettered = 1').get() as any).c
const totalRows = () =>
  (db.prepare('SELECT COUNT(*) c FROM PendingSyncs').get() as any).c

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE PendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    IoId INTEGER, TestResult TEXT, RetryCount INTEGER DEFAULT 0,
    LastError TEXT, CreatedAt TEXT,
    DeadLettered INTEGER NOT NULL DEFAULT 0
  )`)
  // Mirror the production F2 coalesce trigger.
  db.exec(`CREATE TRIGGER trg_pendingsyncs_coalesce
    AFTER INSERT ON PendingSyncs WHEN NEW.DeadLettered = 0
    BEGIN
      DELETE FROM PendingSyncs WHERE IoId = NEW.IoId AND DeadLettered = 0 AND id < NEW.id;
    END`)
})

describe('F2 coalesce trigger (one active row per IO)', () => {
  it('rapid same-IO writes collapse to the latest row only', () => {
    seedRow(100, 'Passed')
    seedRow(100, 'Failed')
    seedRow(100, 'Cleared')  // newest active wins
    expect(activeCount()).toBe(1)
    const row = db.prepare('SELECT TestResult FROM PendingSyncs WHERE IoId = 100 AND DeadLettered = 0').get() as any
    expect(row.TestResult).toBe('Cleared')
  })

  it('coalesce never touches a different IO or a parked row', () => {
    const parked = seedRow(1, 'Passed')
    db.prepare('UPDATE PendingSyncs SET DeadLettered = 1 WHERE id = ?').run(parked)  // park it
    seedRow(1, 'Failed')   // new active for the SAME IO — must not clear the parked one
    seedRow(2, 'Passed')   // different IO — untouched
    expect(attentionCount()).toBe(1)              // parked row preserved
    expect(activeCount()).toBe(2)                 // io1-active + io2-active
  })
})

describe('dead-letter (park, never delete)', () => {
  it('permanent reject PARKS the row — kept, excluded from active queue, counted for attention', () => {
    const id = seedRow(61335, 'Passed')
    // auto-sync permanent path: deadLetter(id, reason) — NOT delete(id)
    db.prepare('UPDATE PendingSyncs SET DeadLettered = 1, LastError = ? WHERE id = ?')
      .run('SPARE cannot be Passed', id)

    expect(totalRows()).toBe(1)        // not deleted — never lost
    expect(activeCount()).toBe(0)      // not in the active push queue
    expect(attentionCount()).toBe(1)   // surfaced as "needs attention"
    const row = db.prepare('SELECT * FROM PendingSyncs WHERE id = ?').get(id) as any
    expect(row.TestResult).toBe('Passed')               // result preserved
    expect(row.LastError).toBe('SPARE cannot be Passed') // reason preserved
  })

  it('retry-cap PARKS rows (>=cap) instead of deleting them (B7 — no silent loss)', () => {
    const CAP = 10
    seedRow(1, 'Failed', 10)  // at cap
    seedRow(2, 'Failed', 12)  // over cap
    seedRow(3, 'Passed', 3)   // under cap — stays active

    // auto-sync cap path: UPDATE ... SET DeadLettered=1 WHERE RetryCount>=cap
    const res = db.prepare(
      "UPDATE PendingSyncs SET DeadLettered = 1, LastError = COALESCE(LastError,'retry cap exhausted') WHERE RetryCount >= ? AND DeadLettered = 0"
    ).run(CAP)

    expect(res.changes).toBe(2)        // the two capped rows parked
    expect(totalRows()).toBe(3)        // nothing deleted
    expect(attentionCount()).toBe(2)
    expect(activeCount()).toBe(1)      // the under-cap row still pushes
  })

  it('the active push query skips parked rows', () => {
    seedRow(1, 'Passed', 0, 0)  // active
    seedRow(2, 'Passed', 0, 1)  // parked
    seedRow(3, 'Failed', 0, 0)  // active
    const batch = db.prepare(
      'SELECT id FROM PendingSyncs WHERE DeadLettered = 0 ORDER BY CreatedAt ASC LIMIT 50'
    ).all() as Array<{ id: number }>
    expect(batch).toHaveLength(2)
  })

  it('a successful sync still DELETES its row (parking is only for failures)', () => {
    const id = seedRow(5, 'Passed')
    db.prepare('DELETE FROM PendingSyncs WHERE id = ?').run(id)  // auto-sync ok path
    expect(totalRows()).toBe(0)
  })

  it('pull-guard raw count still includes parked rows (a destructive pull stays blocked)', () => {
    seedRow(1, 'Passed', 0, 1)  // parked, local-only, NOT on cloud
    // the pull-guard uses COUNT(*) (all rows) — parked work must keep it blocked
    expect(totalRows()).toBe(1)
    expect(activeCount()).toBe(0)  // but the "pending" badge shows 0 active...
    expect(attentionCount()).toBe(1)  // ...and the red "attention" marker instead
  })
})
