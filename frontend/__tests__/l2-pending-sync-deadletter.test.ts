/**
 * Dead-letter semantics for the L2/FV cell sync queue (B7 parity, 2026-06-08).
 *
 * The L2 push path previously DELETED L2PendingSyncs rows once they exhausted
 * the retry cap ("cloud probably has them") — the same silent-loss pattern the
 * IO path already fixed (see pending-sync-deadletter.test.ts). A capped L2 row
 * is genuinely-unsynced wizard cell work; deleting it loses it with no trace.
 *
 * The fix PARKS such rows (DeadLettered=1) instead of deleting, mirroring the
 * IO path:
 *   - they leave the ACTIVE push queue (not retried forever),
 *   - they are NEVER lost (row + value + reason kept),
 *   - they are EXCLUDED from the auto-pull gate so a parked L2 row can't block
 *     cloud→field propagation forever (the documented livelock regression).
 *
 * Tested against the exact SQL the auto-sync L2 path uses, on an in-memory DB.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

let db: Database.Database

function seedRow(deviceId: number, columnId: number, value: string, retry = 0, dead = 0): number {
  const r = db.prepare(
    'INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, RetryCount, DeadLettered, CreatedAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(deviceId, columnId, value, retry, dead, new Date().toISOString())
  return Number(r.lastInsertRowid)
}

const activeCount = () =>
  (db.prepare('SELECT COUNT(*) c FROM L2PendingSyncs WHERE DeadLettered = 0').get() as any).c
const attentionCount = () =>
  (db.prepare('SELECT COUNT(*) c FROM L2PendingSyncs WHERE DeadLettered = 1').get() as any).c
const totalRows = () =>
  (db.prepare('SELECT COUNT(*) c FROM L2PendingSyncs').get() as any).c

beforeEach(() => {
  db = new Database(':memory:')
  // Mirror the production L2PendingSyncs schema (incl. the DeadLettered column).
  db.exec(`CREATE TABLE L2PendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    CloudDeviceId INTEGER NOT NULL,
    CloudColumnId INTEGER NOT NULL,
    Value TEXT,
    UpdatedBy TEXT,
    Version INTEGER DEFAULT 0,
    CreatedAt TEXT DEFAULT (datetime('now')),
    RetryCount INTEGER DEFAULT 0,
    LastError TEXT,
    DeadLettered INTEGER NOT NULL DEFAULT 0
  )`)
})

describe('L2 dead-letter (park, never delete)', () => {
  it('retry-cap PARKS rows (>=cap) instead of deleting them (B7 parity — no silent loss)', () => {
    const CAP = 10
    seedRow(1, 1, 'true', 10)  // at cap
    seedRow(1, 2, 'false', 12) // over cap
    seedRow(2, 1, 'true', 3)   // under cap — stays active

    // auto-sync L2 cap path: UPDATE ... SET DeadLettered=1 WHERE RetryCount>=cap
    const res = db.prepare(
      "UPDATE L2PendingSyncs SET DeadLettered = 1, LastError = COALESCE(LastError, 'L2 retry cap exhausted') WHERE DeadLettered = 0 AND RetryCount >= ?"
    ).run(CAP)

    expect(res.changes).toBe(2)        // the two capped rows parked
    expect(totalRows()).toBe(3)        // nothing deleted — never lost
    expect(attentionCount()).toBe(2)
    expect(activeCount()).toBe(1)      // the under-cap row still pushes

    const parked = db.prepare('SELECT * FROM L2PendingSyncs WHERE CloudDeviceId = 1 AND CloudColumnId = 1').get() as any
    expect(parked.Value).toBe('true')                       // value preserved
    expect(parked.LastError).toBe('L2 retry cap exhausted') // reason preserved
  })

  it('the cap UPDATE does not re-touch an already-parked row (audit/select filters DeadLettered=0)', () => {
    const CAP = 10
    seedRow(1, 1, 'true', 15, 1)  // already parked, over cap
    // the audit SELECT and the park UPDATE both filter DeadLettered = 0
    const toAudit = db.prepare(
      'SELECT id FROM L2PendingSyncs WHERE DeadLettered = 0 AND RetryCount >= ?'
    ).all(CAP) as any[]
    expect(toAudit).toHaveLength(0)  // parked row not re-audited every cycle
    const res = db.prepare(
      "UPDATE L2PendingSyncs SET DeadLettered = 1, LastError = COALESCE(LastError, 'L2 retry cap exhausted') WHERE DeadLettered = 0 AND RetryCount >= ?"
    ).run(CAP)
    expect(res.changes).toBe(0)      // nothing re-parked
  })

  it('the active push query skips parked rows', () => {
    seedRow(1, 1, 'true', 0, 0)  // active
    seedRow(1, 2, 'true', 0, 1)  // parked
    seedRow(2, 1, 'false', 0, 0) // active
    const batch = db.prepare(
      'SELECT id FROM L2PendingSyncs WHERE DeadLettered = 0 ORDER BY CreatedAt ASC LIMIT 50'
    ).all() as Array<{ id: number }>
    expect(batch).toHaveLength(2)
  })

  it('delete-all-for-cell on success leaves parked rows untouched', () => {
    seedRow(1, 1, 'true', 0, 0)  // active, the one that just succeeded
    seedRow(1, 1, 'false', 0, 1) // parked row for the SAME cell — must survive
    db.prepare('DELETE FROM L2PendingSyncs WHERE CloudDeviceId = ? AND CloudColumnId = ? AND DeadLettered = 0').run(1, 1)
    expect(activeCount()).toBe(0)
    expect(attentionCount()).toBe(1)  // parked attention row preserved
  })
})

describe('L2 auto-pull gate — parked rows must NOT block cloud→field propagation', () => {
  // Parity with the IO auto-pull gate: counting parked L2 rows here would make a
  // single permanently-rejected cell block every future pull forever (livelock).
  const autoPullGate = () =>
    (db.prepare('SELECT COUNT(*) c FROM L2PendingSyncs WHERE DeadLettered = 0').get() as any).c

  it('only parked L2 rows present → auto-pull gate is CLEAR (propagation proceeds)', () => {
    seedRow(1, 1, 'true', 0, 1)  // parked, local-only
    seedRow(2, 1, 'false', 0, 1) // another parked
    expect(autoPullGate()).toBe(0)   // gate clear → cloud→field pull runs
    expect(totalRows()).toBe(2)      // rows still kept for attention
    expect(attentionCount()).toBe(2)
  })

  it('a genuinely-unsynced ACTIVE L2 row still defers auto-pull (local work first)', () => {
    seedRow(1, 1, 'true', 0, 0)  // active, genuinely waiting to sync
    seedRow(2, 1, 'true', 0, 1)  // parked
    expect(autoPullGate()).toBe(1)
  })
})
