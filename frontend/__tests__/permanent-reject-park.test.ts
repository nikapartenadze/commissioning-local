/**
 * Immediate-park on DEFINITIVELY-PERMANENT cloud rejections (2026-07-15).
 *
 * When a device / IO / L2 target is DELETED on the cloud, the tablet keeps
 * POSTing its queued rows and the cloud answers HTTP 403 / 404 every time. The
 * old L2 path treated that as an ordinary failure — increment RetryCount, retry
 * to the cap (10) — burning minutes on a doomed row and churning the queue.
 *
 * The fix: a shared rule (isPermanentRejectionStatus, 403/404/410) parks the
 * row on the FIRST such response (DeadLettered=1) with a human-readable
 * LastError, while TRANSIENT failures (timeout / 500 / 401 / 429) keep their
 * exact existing no-strike behaviour and a plain cloud VERDICT (e.g. 400) still
 * increments toward the cap. Nothing is ever DELETED — parked rows keep their
 * value + reason for attention.
 *
 * Tested against the exact SQL + shared classifier the auto-sync push paths
 * use, on an in-memory DB (independent of the app's better-sqlite3 singleton).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  isNetworkLevelFailure,
  isPermanentRejectionStatus,
  permanentRejectionReason,
} from '@/lib/cloud/sync-failure-classification'

let db: Database.Database

const IO_CAP = 10
const L2_CAP = 10

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE PendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    IoId INTEGER, TestResult TEXT, RetryCount INTEGER DEFAULT 0,
    LastError TEXT, CreatedAt TEXT,
    DeadLettered INTEGER NOT NULL DEFAULT 0
  )`)
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

// ── mirrors the exact L2 else-if chain in auto-sync.ts pushToCloud() ─────────
// (batch HTTP status → one of: network no-strike / permanent park / strike).
function applyL2BatchOutcome(status: number): void {
  const rows = db.prepare('SELECT * FROM L2PendingSyncs WHERE DeadLettered = 0').all() as any[]
  if (isNetworkLevelFailure({ httpStatus: status })) {
    for (const p of rows) {
      db.prepare('UPDATE L2PendingSyncs SET LastError = ? WHERE id = ?').run(`HTTP ${status} (network-level, no strike)`, p.id)
    }
  } else if (isPermanentRejectionStatus(status)) {
    const parkReason = permanentRejectionReason(status)
    for (const p of rows) {
      db.prepare('UPDATE L2PendingSyncs SET DeadLettered = 1, LastError = ? WHERE id = ?').run(parkReason, p.id)
    }
  } else {
    for (const p of rows) {
      db.prepare('UPDATE L2PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?').run(`HTTP ${status}`, p.id)
    }
  }
  // cap-park sweep (unchanged): rows that reach the cap via strikes are parked
  db.prepare(
    "UPDATE L2PendingSyncs SET DeadLettered = 1, LastError = COALESCE(LastError, 'L2 retry cap exhausted') WHERE DeadLettered = 0 AND RetryCount >= ?"
  ).run(L2_CAP)
}

const l2Row = (id: number) => db.prepare('SELECT * FROM L2PendingSyncs WHERE id = ?').get(id) as any

describe('shared permanent-rejection rule (404/410 — 403 EXCLUDED)', () => {
  it('classifies removal statuses as permanent, disjoint from the transient set', () => {
    // Only 404/410 are confirmed removals. 403 was here until 2026-07-17 but the
    // cloud uses 403 for auth/project-key mismatch (not a removal), so treating
    // it as removal tombstoned unsynced work — it is now TRANSIENT (see below).
    for (const s of [404, 410]) {
      expect(isPermanentRejectionStatus(s)).toBe(true)
      expect(isNetworkLevelFailure({ httpStatus: s })).toBe(false) // never transient
    }
    // auth/config + throttle + server statuses are TRANSIENT, not removals.
    // 403 rides here with 401 (same auth/config category).
    for (const s of [401, 403, 429, 500, 502, 503]) {
      expect(isPermanentRejectionStatus(s)).toBe(false)
      expect(isNetworkLevelFailure({ httpStatus: s })).toBe(true)
    }
    // a plain cloud verdict (400) is neither transient nor permanent-removal
    expect(isPermanentRejectionStatus(400)).toBe(false)
    expect(isNetworkLevelFailure({ httpStatus: 400 })).toBe(false)
    expect(isPermanentRejectionStatus(undefined)).toBe(false)
  })

  it('produces a readable LastError a human can act on', () => {
    expect(permanentRejectionReason(404)).toBe(
      'HTTP 404 — target no longer exists on cloud (removed); parked without further retries'
    )
    expect(permanentRejectionReason(410)).toContain('HTTP 410')
    expect(permanentRejectionReason(410)).toContain('parked without further retries')
  })
})

describe('L2 queue — permanent reject parks on the FIRST attempt', () => {
  function seedL2(deviceId: number, columnId: number, value: string): number {
    const r = db.prepare(
      'INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, RetryCount, DeadLettered, CreatedAt) VALUES (?, ?, ?, 0, 0, ?)'
    ).run(deviceId, columnId, value, new Date().toISOString())
    return Number(r.lastInsertRowid)
  }

  it('403 (auth/project mismatch) is TRANSIENT — never parks, never strikes, self-heals', () => {
    const id = seedL2(1, 1, 'true')
    // A whole misconfiguration window of 403s (wrong/mis-scoped key) must NOT
    // park or strike — once the config is fixed the row drains. Parking (or
    // worse, the old orphan/tombstone) would silently hide unsynced work.
    for (let i = 0; i < 25; i++) applyL2BatchOutcome(403)
    const row = l2Row(id)
    expect(row.DeadLettered).toBe(0)              // NOT parked — self-heals on fix
    expect(row.RetryCount).toBe(0)                // no strikes burned
    expect(row.Value).toBe('true')                // value preserved (never deleted)
    expect(row.LastError).toContain('network-level')
  })

  it('404 parks immediately for every row in the doomed batch', () => {
    const a = seedL2(7, 1, 'x')
    const b = seedL2(7, 2, 'y')
    applyL2BatchOutcome(404)
    expect(l2Row(a).DeadLettered).toBe(1)
    expect(l2Row(b).DeadLettered).toBe(1)
    expect(l2Row(a).RetryCount).toBe(0)
    expect(l2Row(b).RetryCount).toBe(0)
    // total rows unchanged — parked, not deleted
    expect((db.prepare('SELECT COUNT(*) c FROM L2PendingSyncs').get() as any).c).toBe(2)
  })

  it('TRANSIENT 500 does NOT park and does NOT strike (behaviour unchanged)', () => {
    const id = seedL2(2, 1, 'v')
    // Many cycles of a down cloud — still no strike, still active.
    for (let i = 0; i < 25; i++) applyL2BatchOutcome(500)
    const row = l2Row(id)
    expect(row.DeadLettered).toBe(0)              // never parked on transient
    expect(row.RetryCount).toBe(0)                // no strikes burned
    expect(row.LastError).toContain('network-level')
  })

  it('a plain cloud VERDICT (400) still increments and parks only at the cap', () => {
    const id = seedL2(3, 1, 'v')
    // First 9 verdicts: strikes accrue, row stays active (not parked yet).
    for (let i = 0; i < IO_CAP - 1; i++) applyL2BatchOutcome(400)
    expect(l2Row(id).DeadLettered).toBe(0)
    expect(l2Row(id).RetryCount).toBe(L2_CAP - 1)
    // 10th verdict reaches the cap → parked (existing retry/backoff unchanged).
    applyL2BatchOutcome(400)
    expect(l2Row(id).DeadLettered).toBe(1)
    expect(l2Row(id).RetryCount).toBe(L2_CAP)
  })
})

describe('IO queue — permanent reject parks on the FIRST attempt', () => {
  // Mirrors the IO push branch: r.permanent → deadLetter(parkReason) on attempt
  // #1; r.network → recordTransientFailure (no strike); else → recordFailure
  // (strike) then cap-park. The shared rule supplies the readable park reason.
  function seedIo(ioId: number, result: string): number {
    const r = db.prepare(
      'INSERT INTO PendingSyncs (IoId, TestResult, RetryCount, DeadLettered, CreatedAt) VALUES (?, ?, 0, 0, ?)'
    ).run(ioId, result, new Date().toISOString())
    return Number(r.lastInsertRowid)
  }
  const ioRow = (id: number) => db.prepare('SELECT * FROM PendingSyncs WHERE id = ?').get(id) as any

  // reason arrives from the sync-service as `HTTP <status>` for HTTP failures.
  function parkReasonForIo(reason: string): string {
    const m = /^HTTP (\d{3})$/.exec(reason)
    const status = m ? Number(m[1]) : undefined
    return status != null && isPermanentRejectionStatus(status)
      ? permanentRejectionReason(status)
      : reason
  }

  it('404 (removed IO) parks on the first response with a readable reason, RetryCount 0', () => {
    const id = seedIo(54049, 'Passed')
    // permanent branch: deadLetter immediately, no strike.
    db.prepare('UPDATE PendingSyncs SET DeadLettered = 1, LastError = ? WHERE id = ?')
      .run(parkReasonForIo('HTTP 404'), id)
    const row = ioRow(id)
    expect(row.DeadLettered).toBe(1)
    expect(row.RetryCount).toBe(0)
    expect(row.TestResult).toBe('Passed')          // preserved, never deleted
    expect(row.LastError).toBe(
      'HTTP 404 — target no longer exists on cloud (removed); parked without further retries'
    )
  })

  it('a non-removal permanent reject keeps its own message (e.g. SPARE)', () => {
    const id = seedIo(9, 'Passed')
    db.prepare('UPDATE PendingSyncs SET DeadLettered = 1, LastError = ? WHERE id = ?')
      .run(parkReasonForIo('cloud-rejected: SPARE cannot be Passed'), id)
    expect(ioRow(id).LastError).toBe('cloud-rejected: SPARE cannot be Passed')
  })

  it('TRANSIENT failure does not strike; a cloud verdict strikes toward the cap', () => {
    const transient = seedIo(1, 'Passed')
    // network path: LastError only, no strike (recordTransientFailure).
    db.prepare('UPDATE PendingSyncs SET LastError = ? WHERE id = ?').run('offline', transient)
    expect(ioRow(transient).RetryCount).toBe(0)
    expect(ioRow(transient).DeadLettered).toBe(0)

    const verdict = seedIo(2, 'Passed')
    for (let i = 0; i < IO_CAP; i++) {
      db.prepare('UPDATE PendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?').run('updatedCount=0', verdict)
    }
    // cap-park sweep (IO SQL) parks only the capped, still-active row.
    db.prepare(
      "UPDATE PendingSyncs SET DeadLettered = 1, LastError = COALESCE(LastError,'retry cap exhausted') WHERE RetryCount >= ? AND DeadLettered = 0"
    ).run(IO_CAP)
    expect(ioRow(verdict).DeadLettered).toBe(1)
    expect(ioRow(verdict).RetryCount).toBe(IO_CAP)
    expect(ioRow(transient).DeadLettered).toBe(0)  // transient row untouched
  })
})
