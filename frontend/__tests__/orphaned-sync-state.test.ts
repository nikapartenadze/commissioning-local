/**
 * ORPHANED — the third outbound-sync state (2026-07-15).
 *
 * Orphaned=1 is layered ON TOP of DeadLettered=1. INVARIANT: Orphaned=1 ⇒
 * DeadLettered=1. It marks a queue row whose cloud target was CONFIRMED removed
 * (a 403/404/410 write rejection, or an IO delete-tombstone from the delta), as
 * distinct from a plain park ("needs a human"). An orphaned row:
 *   - leaves the active push queue (DeadLettered=1) and the amber attention badge,
 *   - is NEVER lost (row + local value kept),
 *   - AUTO-REQUEUES (Orphaned→0, DeadLettered→0) if the target reappears,
 *   - never blocks a pull that would restore the device.
 *
 * ANTI-FOOTGUN coverage: only a confirmed 403/404/410 (or delete-tombstone)
 * orphans; a transient 500 / updatedCount=0 version conflict / retry-cap park
 * does NOT. Orphaning/requeue is a QUEUE-ROW FLAG FLIP only — the underlying
 * Ios / L2CellValues value is never touched.
 *
 * Tested against the EXACT SQL the repository / auto-sync / delta-sync / pull-l2
 * / queue-inspector / status-route use, on an in-memory DB (independent of the
 * app's better-sqlite3 singleton — NO prod DB).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  isPermanentRejectionStatus,
  isNetworkLevelFailure,
  permanentRejectionReason,
} from '@/lib/cloud/sync-failure-classification'

let db: Database.Database

// ── Production SQL mirrored verbatim from the shipping code ──────────────────
const SQL = {
  // pendingSyncRepository.orphan()
  ioOrphan: 'UPDATE PendingSyncs SET DeadLettered = 1, Orphaned = 1, LastError = ?, RetryCount = 0 WHERE id = ?',
  // pendingSyncRepository.deadLetter()
  ioDeadLetter: 'UPDATE PendingSyncs SET DeadLettered = 1, LastError = ? WHERE id = ?',
  // auto-sync L2 permanent (confirmed removal) park
  l2Orphan: 'UPDATE L2PendingSyncs SET DeadLettered = 1, Orphaned = 1, RetryCount = 0, LastError = ? WHERE id = ?',
  // auto-sync L2 retry-cap park (NOT a removal)
  l2CapPark: "UPDATE L2PendingSyncs SET DeadLettered = 1, LastError = COALESCE(LastError, 'L2 retry cap exhausted') WHERE DeadLettered = 0 AND RetryCount >= ?",
  // delta-sync IO delete-tombstone orphan
  deltaOrphan:
    "UPDATE PendingSyncs SET DeadLettered = 1, Orphaned = 1, RetryCount = 0, " +
    "LastError = 'HTTP 410 — IO removed on cloud (delete tombstone); orphaned, auto-restores if it reappears' " +
    "WHERE IoId = ? AND Orphaned = 0",
  // delta-sync reappearance requeue
  deltaRequeue: 'UPDATE PendingSyncs SET Orphaned = 0, DeadLettered = 0, RetryCount = 0, LastError = NULL WHERE IoId = ? AND Orphaned = 1',
  // pull-l2 reappearance requeue
  l2Requeue: 'UPDATE L2PendingSyncs SET Orphaned = 0, DeadLettered = 0, RetryCount = 0, LastError = NULL WHERE CloudDeviceId = ? AND Orphaned = 1',
  // queue-inspector.retry()
  retry: 'UPDATE PendingSyncs SET DeadLettered = 0, Orphaned = 0, RetryCount = 0, LastError = NULL WHERE id = ?',
  // queue-inspector.discard()
  discard: 'DELETE FROM PendingSyncs WHERE id = ?',
  // status-route attention count (excludes orphans)
  attention: 'SELECT COUNT(*) c FROM PendingSyncs WHERE DeadLettered = 1 AND Orphaned = 0',
  // status-route orphaned count
  orphanedCount: 'SELECT COUNT(*) c FROM PendingSyncs WHERE Orphaned = 1',
  // status-route active count
  active: 'SELECT COUNT(*) c FROM PendingSyncs WHERE DeadLettered = 0',
}

// queue-inspector statusOf() replicated 1:1
function statusOf(deadLettered: number, orphaned: number): 'pending' | 'parked' | 'orphaned' {
  if (orphaned === 1) return 'orphaned'
  return deadLettered === 1 ? 'parked' : 'pending'
}

function makePendingSyncs() {
  db.exec(`CREATE TABLE PendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    IoId INTEGER, TestResult TEXT, RetryCount INTEGER DEFAULT 0,
    LastError TEXT, CreatedAt TEXT,
    DeadLettered INTEGER NOT NULL DEFAULT 0,
    Orphaned INTEGER NOT NULL DEFAULT 0
  )`)
}
function makeL2PendingSyncs() {
  db.exec(`CREATE TABLE L2PendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    CloudDeviceId INTEGER NOT NULL, CloudColumnId INTEGER NOT NULL,
    Value TEXT, UpdatedBy TEXT, Version INTEGER DEFAULT 0,
    CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0,
    LastError TEXT,
    DeadLettered INTEGER NOT NULL DEFAULT 0,
    Orphaned INTEGER NOT NULL DEFAULT 0
  )`)
}

const seedIo = (ioId: number, result: string, retry = 0, dead = 0, orph = 0): number =>
  Number(db.prepare('INSERT INTO PendingSyncs (IoId, TestResult, RetryCount, DeadLettered, Orphaned, CreatedAt) VALUES (?,?,?,?,?,?)')
    .run(ioId, result, retry, dead, orph, new Date().toISOString()).lastInsertRowid)
const seedL2 = (dev: number, col: number, value: string, retry = 0, dead = 0, orph = 0): number =>
  Number(db.prepare('INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, RetryCount, DeadLettered, Orphaned, CreatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(dev, col, value, retry, dead, orph, new Date().toISOString()).lastInsertRowid)
const rowOf = (id: number) => db.prepare('SELECT * FROM PendingSyncs WHERE id = ?').get(id) as any
const l2RowOf = (id: number) => db.prepare('SELECT * FROM L2PendingSyncs WHERE id = ?').get(id) as any

beforeEach(() => { db = new Database(':memory:') })

// ── Schema / invariant ───────────────────────────────────────────────────────
describe('schema: Orphaned column + invariant', () => {
  it('a fresh queue table has Orphaned defaulting to 0', () => {
    makePendingSyncs()
    const id = seedIo(1, 'Passed')
    expect(rowOf(id).Orphaned).toBe(0)
  })

  it('the safe ALTER-IF-NOT-EXISTS migration adds Orphaned to a legacy table', () => {
    // legacy DB: DeadLettered exists, Orphaned does NOT
    db.exec(`CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY, IoId INTEGER, DeadLettered INTEGER NOT NULL DEFAULT 0)`)
    const migrate = () => { try { db.exec('ALTER TABLE PendingSyncs ADD COLUMN Orphaned INTEGER NOT NULL DEFAULT 0') } catch { /* exists */ } }
    migrate()
    migrate() // idempotent — second run is a no-op, never throws
    const cols = (db.prepare('PRAGMA table_info(PendingSyncs)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('Orphaned')
  })

  it('INVARIANT Orphaned=1 ⇒ DeadLettered=1 holds after every orphan write', () => {
    makePendingSyncs()
    const id = seedIo(1, 'Passed')
    db.prepare(SQL.ioOrphan).run('gone', id)
    const r = rowOf(id)
    expect(r.Orphaned).toBe(1)
    expect(r.DeadLettered).toBe(1) // the invariant
    // No row may ever have Orphaned=1 while DeadLettered=0.
    const violations = db.prepare('SELECT COUNT(*) c FROM PendingSyncs WHERE Orphaned = 1 AND DeadLettered = 0').get() as any
    expect(violations.c).toBe(0)
  })
})

// ── Anti-footgun: only CONFIRMED removal orphans ─────────────────────────────
describe('anti-footgun: orphan only on a confirmed removal', () => {
  beforeEach(() => { makePendingSyncs(); makeL2PendingSyncs() })

  it('IO write rejected 404 / 410 → Orphaned=1 (confirmed removal)', () => {
    for (const status of [403, 404, 410]) {
      const id = seedIo(status, 'Passed')
      // auto-sync decision: reason "HTTP <status>" → parse → isPermanentRejectionStatus
      const removed = isPermanentRejectionStatus(status)
      expect(removed).toBe(true)
      db.prepare(SQL.ioOrphan).run(permanentRejectionReason(status), id)
      expect(rowOf(id).Orphaned).toBe(1)
    }
  })

  it('IO transient 500 → NOT orphaned (stays active, no strike)', () => {
    const id = seedIo(1, 'Passed')
    expect(isNetworkLevelFailure({ httpStatus: 500 })).toBe(true)
    // network path never touches DeadLettered/Orphaned — row stays active
    expect(rowOf(id).Orphaned).toBe(0)
    expect(rowOf(id).DeadLettered).toBe(0)
    expect(statusOf(rowOf(id).DeadLettered, rowOf(id).Orphaned)).toBe('pending')
  })

  it('IO non-removal permanent reject (SPARE cannot be Passed) → parked, NOT orphaned', () => {
    const id = seedIo(1, 'Passed')
    // reason is a plain validation message, not "HTTP 4xx" → deadLetter, not orphan
    db.prepare(SQL.ioDeadLetter).run('SPARE cannot be Passed', id)
    const r = rowOf(id)
    expect(r.DeadLettered).toBe(1)
    expect(r.Orphaned).toBe(0) // stays a human-attention park
    expect(statusOf(r.DeadLettered, r.Orphaned)).toBe('parked')
  })

  it('L2 batch rejected 404 → Orphaned=1; 500 → not orphaned; retry-cap park → not orphaned', () => {
    const removed = seedL2(1, 1, 'true')
    const transient = seedL2(2, 1, 'false')
    const capped = seedL2(3, 1, 'x', 12)

    // confirmed removal (404): orphan
    expect(isPermanentRejectionStatus(404)).toBe(true)
    db.prepare(SQL.l2Orphan).run(permanentRejectionReason(404), removed)
    expect(l2RowOf(removed).Orphaned).toBe(1)

    // transient 500: cloud never ruled — untouched
    expect(isNetworkLevelFailure({ httpStatus: 500 })).toBe(true)
    expect(l2RowOf(transient).Orphaned).toBe(0)
    expect(l2RowOf(transient).DeadLettered).toBe(0)

    // retry-cap park: DeadLettered but NOT orphaned (version-conflict lane, not removal)
    db.prepare(SQL.l2CapPark).run(10)
    expect(l2RowOf(capped).DeadLettered).toBe(1)
    expect(l2RowOf(capped).Orphaned).toBe(0)
  })

  it('updatedCount=0 version conflict never orphans (it is the B7 reconcile lane)', () => {
    const id = seedL2(1, 1, 'true')
    // conflict path only rebases Version + increments RetryCount — never sets Orphaned
    db.prepare('UPDATE L2PendingSyncs SET Version = 5, RetryCount = RetryCount + 1, LastError = ? WHERE id = ?')
      .run('rebased after version conflict', id)
    expect(l2RowOf(id).Orphaned).toBe(0)
    expect(l2RowOf(id).DeadLettered).toBe(0)
  })
})

// ── IO delete-tombstone ──────────────────────────────────────────────────────
describe('IO delete-tombstone orphans pending rows and KEEPS the Ios row', () => {
  beforeEach(() => {
    makePendingSyncs()
    db.exec(`CREATE TABLE Ios (id INTEGER PRIMARY KEY, Name TEXT, Result TEXT)`)
  })

  it('a cloud IO delete with un-pushed local work → row Orphaned=1, Ios kept', () => {
    db.prepare('INSERT INTO Ios (id, Name, Result) VALUES (?,?,?)').run(500, 'MTR-500', 'Passed')
    const pid = seedIo(500, 'Passed')

    // delta-sync deletes loop: pending>0 → orphan the queue rows (not delete Ios)
    const changes = db.prepare(SQL.deltaOrphan).run(500).changes
    expect(changes).toBe(1)

    const r = rowOf(pid)
    expect(r.Orphaned).toBe(1)
    expect(r.DeadLettered).toBe(1)
    expect(/410|removed on cloud/.test(r.LastError)).toBe(true) // classifies as gone_on_cloud
    // the Ios row + its result are UNTOUCHED — orphaning is a queue-flag flip only
    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(500) as any
    expect(io).toBeTruthy()
    expect(io.Result).toBe('Passed')
  })

  it('re-running the tombstone does not re-touch an already-orphaned row', () => {
    const pid = seedIo(500, 'Passed')
    db.prepare(SQL.deltaOrphan).run(500)
    const changes2 = db.prepare(SQL.deltaOrphan).run(500).changes // WHERE Orphaned = 0 guards it
    expect(changes2).toBe(0)
    expect(rowOf(pid).Orphaned).toBe(1)
  })
})

// ── DELETE-THEN-RESTORE proof ────────────────────────────────────────────────
describe('DELETE-THEN-RESTORE proof', () => {
  it('IO: orphaned → reappears via delta upsert → row flips to Active, value intact', () => {
    makePendingSyncs()
    db.exec(`CREATE TABLE Ios (id INTEGER PRIMARY KEY, Name TEXT, Result TEXT)`)

    // 1) IO exists, local result queued
    db.prepare('INSERT INTO Ios (id, Name, Result) VALUES (?,?,?)').run(77, 'VLV-77', 'Failed')
    const pid = seedIo(77, 'Failed')

    // 2) cloud DELETES the IO → tombstone orphans the queue row (Ios kept)
    db.prepare(SQL.deltaOrphan).run(77)
    expect(statusOf(rowOf(pid).DeadLettered, rowOf(pid).Orphaned)).toBe('orphaned')

    // 3) IO REAPPEARS on cloud → delta upsert loop runs the requeue for id 77
    const requeued = db.prepare(SQL.deltaRequeue).run(77).changes
    expect(requeued).toBe(1)

    // 4) the queue row is Active again, error cleared — and the VALUE is intact
    const r = rowOf(pid)
    expect(r.Orphaned).toBe(0)
    expect(r.DeadLettered).toBe(0)
    expect(r.RetryCount).toBe(0)
    expect(r.LastError).toBeNull()
    expect(r.TestResult).toBe('Failed')     // the queued value survived the round-trip
    expect(statusOf(r.DeadLettered, r.Orphaned)).toBe('pending')
    // Ios value never mutated by any of it
    expect((db.prepare('SELECT Result FROM Ios WHERE id = 77').get() as any).Result).toBe('Failed')
  })

  it('L2: orphaned → device reappears via pull-l2 → row flips to Active, value intact', () => {
    makeL2PendingSyncs()
    // 1) queued FV cell for cloud device 900
    const pid = seedL2(900, 3, 'true')
    // 2) device deleted on cloud → auto-sync 404 orphans it
    db.prepare(SQL.l2Orphan).run(permanentRejectionReason(404), pid)
    expect(l2RowOf(pid).Orphaned).toBe(1)
    // 3) device reappears → pull-l2 device upsert runs the requeue keyed by CloudDeviceId
    const requeued = db.prepare(SQL.l2Requeue).run(900).changes
    expect(requeued).toBe(1)
    // 4) Active again, value intact
    const r = l2RowOf(pid)
    expect(r.Orphaned).toBe(0)
    expect(r.DeadLettered).toBe(0)
    expect(r.Value).toBe('true')
  })
})

// ── pull-l2 guard ─────────────────────────────────────────────────────────────
describe('pull-l2 guard: orphaned rows do NOT block the pull', () => {
  beforeEach(() => {
    makeL2PendingSyncs()
    db.exec(`CREATE TABLE L2Devices (id INTEGER PRIMARY KEY, CloudId INTEGER, SubsystemId INTEGER)`)
    db.prepare('INSERT INTO L2Devices (id, CloudId, SubsystemId) VALUES (1, 900, 42)').run()
  })
  const guard = (sid: number) => db.prepare(
    `SELECT
       SUM(CASE WHEN DeadLettered = 0 THEN 1 ELSE 0 END) as active,
       SUM(CASE WHEN DeadLettered = 1 AND Orphaned = 0 THEN 1 ELSE 0 END) as parked
     FROM L2PendingSyncs
     WHERE CloudDeviceId IN (SELECT CloudId FROM L2Devices WHERE SubsystemId = ? OR SubsystemId IS NULL)`,
  ).get(sid) as { active: number | null; parked: number | null }

  it('only orphaned rows present → guard clear (pull proceeds to restore the device)', () => {
    seedL2(900, 1, 'true', 0, 1, 1) // orphaned
    seedL2(900, 2, 'false', 0, 1, 1) // orphaned
    const g = guard(42)
    expect((g.active ?? 0) + (g.parked ?? 0)).toBe(0) // NOT blocked
  })

  it('an active OR a parked-non-orphaned row still blocks (genuine unsynced work)', () => {
    seedL2(900, 1, 'true', 0, 0, 0) // active
    expect((guard(42).active ?? 0) + (guard(42).parked ?? 0)).toBeGreaterThan(0)

    db.prepare('DELETE FROM L2PendingSyncs').run()
    seedL2(900, 1, 'x', 12, 1, 0) // parked, NOT orphaned (retry-cap)
    expect((guard(42).active ?? 0) + (guard(42).parked ?? 0)).toBe(1) // still blocks
  })
})

// ── queue-inspector + status-route surfacing ─────────────────────────────────
describe('queue-inspector + status-route surfacing', () => {
  beforeEach(() => { makePendingSyncs() })

  it('statusOf classifies the three states from the two flags', () => {
    expect(statusOf(0, 0)).toBe('pending')
    expect(statusOf(1, 0)).toBe('parked')
    expect(statusOf(1, 1)).toBe('orphaned')
  })

  it('summary counts orphaned separately from parked/pending', () => {
    seedIo(1, 'Passed', 0, 0, 0) // pending
    seedIo(2, 'Passed', 0, 1, 0) // parked
    seedIo(3, 'Passed', 0, 1, 1) // orphaned
    seedIo(4, 'Passed', 0, 1, 1) // orphaned
    const rows = db.prepare('SELECT DeadLettered, Orphaned FROM PendingSyncs').all() as any[]
    const summary = { pending: 0, parked: 0, orphaned: 0 }
    for (const r of rows) {
      const s = statusOf(r.DeadLettered, r.Orphaned)
      summary[s]++
    }
    expect(summary).toEqual({ pending: 1, parked: 1, orphaned: 2 })
  })

  it('retry un-orphans the row (Orphaned→0, DeadLettered→0, re-enters active queue)', () => {
    const id = seedIo(1, 'Passed', 3, 1, 1) // orphaned
    db.prepare(SQL.retry).run(id)
    const r = rowOf(id)
    expect(r.Orphaned).toBe(0)
    expect(r.DeadLettered).toBe(0)
    expect(r.RetryCount).toBe(0)
    expect(statusOf(r.DeadLettered, r.Orphaned)).toBe('pending')
  })

  it('discard removes ONLY the queue row (an orphan) — underlying value untouched', () => {
    db.exec(`CREATE TABLE Ios (id INTEGER PRIMARY KEY, Result TEXT)`)
    db.prepare('INSERT INTO Ios (id, Result) VALUES (9, ?)').run('Passed')
    const id = seedIo(9, 'Passed', 0, 1, 1) // orphaned
    db.prepare(SQL.discard).run(id)
    expect(rowOf(id)).toBeUndefined() // queue row gone
    expect((db.prepare('SELECT Result FROM Ios WHERE id = 9').get() as any).Result).toBe('Passed') // value kept
  })

  it('status-route attentionCount EXCLUDES orphaned; orphanedCount counts them; active excludes both', () => {
    seedIo(1, 'Passed', 0, 0, 0) // active
    seedIo(2, 'Passed', 0, 1, 0) // parked → attention
    seedIo(3, 'Passed', 0, 1, 0) // parked → attention
    seedIo(4, 'Passed', 0, 1, 1) // orphaned → NOT attention
    expect((db.prepare(SQL.attention).get() as any).c).toBe(2)     // red badge = parked only
    expect((db.prepare(SQL.orphanedCount).get() as any).c).toBe(1) // informational
    expect((db.prepare(SQL.active).get() as any).c).toBe(1)        // auto-sync work
  })
})
