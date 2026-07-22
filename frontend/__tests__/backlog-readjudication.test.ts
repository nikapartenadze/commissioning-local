/**
 * ONE-TIME BACKLOG RE-ADJUDICATION + QUEUE-AGE WATCHDOG (2026-07-22).
 *
 * The rejection-code routing shipped in 029bcfa only fixes NEW rejections. Rows
 * parked by the OLD path are DeadLettered=1, are never retried, and therefore
 * never reach the fixed code — the standing backlog would sit in the
 * needs-a-human bucket forever. These tests pin the sweep that clears it, and in
 * particular the three properties that make it safe to run on a populated field
 * database:
 *
 *   1. It NEVER bulk-resolves on the strength of the English LastError string.
 *      Rows are RELEASED for a real cloud verdict, not judged locally.
 *   2. It is gated on PROOF that the cloud emits machine-readable codes, so a
 *      row's single retry is never burned against a pre-`code` cloud.
 *   3. It is AT MOST ONCE per row, enforced by a durable column — a released row
 *      that re-parks can never be picked up again (no infinite requeue loop).
 *
 * And the invariant that outranks all of them: NO ROW IS EVER DELETED.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  // Faithful mirror of the production queue schema (lib/db-sqlite.ts), including
  // the ReAdjudicatedAt marker and the SyncMaintenanceFlags KV table.
  d.exec(`
    CREATE TABLE Ios (id INTEGER PRIMARY KEY, Name TEXT, Description TEXT, Result TEXT,
      SubsystemId INTEGER, CloudRemoved INTEGER DEFAULT 0);
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE L2Devices (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, DeviceName TEXT, Mcm TEXT, SubsystemId INTEGER);
    CREATE TABLE L2Columns (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, Name TEXT);

    CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, TestResult TEXT,
      RetryCount INTEGER DEFAULT 0, LastError TEXT, CreatedAt TEXT DEFAULT (datetime('now')),
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0,
      Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT,
      ReAdjudicatedAt TEXT);
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudDeviceId INTEGER,
      CloudColumnId INTEGER, Value TEXT, CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0,
      Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE DeviceBlockerPendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      DeviceName TEXT, Op TEXT, CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0,
      Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE EStopCheckPendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0,
      ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE GuidedTaskStatePendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0,
      ResolvedAt TEXT, ResolvedReason TEXT);

    CREATE TABLE SyncMaintenanceFlags (Key TEXT PRIMARY KEY, Value TEXT, UpdatedAt TEXT);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
// The recovery journal writes to disk; silence it so the suite stays hermetic.
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: () => {} }))

import {
  runBacklogReAdjudication,
  resolveSettledOrphans,
  noteCloudEmitsRejectionCode,
  cloudEmitsRejectionCode,
  getReAdjudicationState,
  __resetReAdjudicationCachesForTests,
} from '@/lib/sync/backlog-readjudication'
import { collectQueueStats, QUEUE_AGE_WATCHDOG_MINUTES } from '@/lib/heartbeat/queue-stats'

/** The exact English text a deleted IO left behind under the OLD (pre-code) path. */
const GONE_ERROR = 'cloud-rejected: IO not found'
/** A parked row that is NOT a removal — must never be touched by the sweep. */
const CONFLICT_ERROR = 'updatedCount=0 — cloud has a newer version'
const SPARE_ERROR = 'cloud-rejected: SPARE cannot be Passed'

function reset() {
  for (const t of [
    'PendingSyncs', 'L2PendingSyncs', 'DeviceBlockerPendingSyncs',
    'EStopCheckPendingSyncs', 'GuidedTaskStatePendingSyncs', 'SyncMaintenanceFlags',
    'Ios',
  ]) memDb.exec(`DELETE FROM ${t}`)
  __resetReAdjudicationCachesForTests()
}

/** Seed a PARKED (DeadLettered=1, not orphaned) IO queue row. Returns its id. */
function seedParked(lastError: string, createdAt = '2026-07-01 08:00:00'): number {
  const io = memDb
    .prepare("INSERT INTO Ios (Name, Result) VALUES ('DI_TEST', 'Passed')")
    .run().lastInsertRowid as number
  return memDb
    .prepare(
      `INSERT INTO PendingSyncs (IoId, TestResult, RetryCount, LastError, CreatedAt, DeadLettered)
       VALUES (?, 'Passed', 10, ?, ?, 1)`,
    )
    .run(io, lastError, createdAt).lastInsertRowid as number
}

function row(id: number) {
  return memDb.prepare('SELECT * FROM PendingSyncs WHERE id = ?').get(id) as any
}

function totalQueueRows(): number {
  return (memDb.prepare('SELECT COUNT(*) c FROM PendingSyncs').get() as any).c
}

beforeEach(reset)

// ---------------------------------------------------------------------------
// (a) Settled orphans — bookkeeping on a conclusion the cloud already reached
// ---------------------------------------------------------------------------

describe('(a) settled orphans are closed as Resolved', () => {
  it('resolves Orphaned=1 AND Resolved=0 across every queue that has an Orphaned column', () => {
    memDb.prepare("INSERT INTO PendingSyncs (IoId, TestResult, LastError, DeadLettered, Orphaned) VALUES (1, 'Passed', ?, 1, 1)").run(GONE_ERROR)
    memDb.prepare("INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, DeadLettered, Orphaned) VALUES (5, 2, 'true', 1, 1)").run()
    memDb.prepare("INSERT INTO DeviceBlockerPendingSyncs (SubsystemId, DeviceName, Op, DeadLettered, Orphaned) VALUES (1, 'VFD-7', 'set', 1, 1)").run()

    expect(resolveSettledOrphans().resolved).toBe(3)

    for (const t of ['PendingSyncs', 'L2PendingSyncs', 'DeviceBlockerPendingSyncs']) {
      const r = memDb.prepare(`SELECT Resolved, ResolvedAt, ResolvedReason FROM ${t}`).get() as any
      expect(r.Resolved).toBe(1)
      expect(r.ResolvedAt).toBeTruthy()
      expect(String(r.ResolvedReason)).toContain('already confirmed')
    }
  })

  it('is idempotent — a second pass changes nothing and deletes nothing', () => {
    memDb.prepare("INSERT INTO PendingSyncs (IoId, TestResult, DeadLettered, Orphaned) VALUES (1, 'Passed', 1, 1)").run()
    expect(resolveSettledOrphans().resolved).toBe(1)
    expect(resolveSettledOrphans().resolved).toBe(0)
    expect(totalQueueRows()).toBe(1)
  })

  it('preserves the test value — Resolved hides a row, it never destroys it', () => {
    memDb.prepare("INSERT INTO PendingSyncs (IoId, TestResult, DeadLettered, Orphaned) VALUES (1, 'Failed', 1, 1)").run()
    resolveSettledOrphans()
    expect((memDb.prepare('SELECT TestResult FROM PendingSyncs').get() as any).TestResult).toBe('Failed')
  })
})

// ---------------------------------------------------------------------------
// The cloud-emits-code capability gate
// ---------------------------------------------------------------------------

describe('cloud rejection-code capability gate', () => {
  it('starts unknown and is banked durably once observed', () => {
    expect(cloudEmitsRejectionCode()).toBe(false)
    noteCloudEmitsRejectionCode()
    expect(cloudEmitsRejectionCode()).toBe(true)
    expect(getReAdjudicationState().cloudEmitsCodeAt).toBeTruthy()
  })

  it('survives a process restart via the durable flag, not an in-memory boolean', () => {
    noteCloudEmitsRejectionCode()
    __resetReAdjudicationCachesForTests() // simulate a reboot
    expect(cloudEmitsRejectionCode()).toBe(true)
  })

  it('releases only ONE canary row while the capability is unknown', () => {
    const ids = [seedParked(GONE_ERROR, '2026-07-01 08:00:00'), seedParked(GONE_ERROR, '2026-07-02 08:00:00'), seedParked(GONE_ERROR, '2026-07-03 08:00:00')]

    const res = runBacklogReAdjudication()
    expect(res.status).toBe('canary_released')
    expect(res.released).toBe(1)

    // Oldest first — the canary is the row that has been stuck longest.
    expect(row(ids[0]).DeadLettered).toBe(0)
    expect(row(ids[0]).ReAdjudicatedAt).toBeTruthy()
    // The rest are UNTOUCHED: releasing them against a pre-`code` cloud would
    // burn the one retry each of them will ever get.
    expect(row(ids[1]).DeadLettered).toBe(1)
    expect(row(ids[1]).ReAdjudicatedAt).toBeNull()
    expect(row(ids[2]).DeadLettered).toBe(1)
    expect(row(ids[2]).ReAdjudicatedAt).toBeNull()
    expect(getReAdjudicationState().sweepCompletedAt).toBeNull()
  })

  it('does not release a second canary in the same process', () => {
    seedParked(GONE_ERROR, '2026-07-01 08:00:00')
    seedParked(GONE_ERROR, '2026-07-02 08:00:00')
    expect(runBacklogReAdjudication().released).toBe(1)
    const again = runBacklogReAdjudication()
    expect(again.released).toBe(0)
    expect(again.status).toBe('awaiting_cloud_capability')
  })

  it('releases the whole remaining backlog once the capability is proven', () => {
    const ids = [seedParked(GONE_ERROR, '2026-07-01 08:00:00'), seedParked(GONE_ERROR, '2026-07-02 08:00:00'), seedParked(GONE_ERROR, '2026-07-03 08:00:00')]
    noteCloudEmitsRejectionCode()

    const res = runBacklogReAdjudication()
    expect(res.status).toBe('complete')
    expect(res.released).toBe(3)
    for (const id of ids) {
      const r = row(id)
      expect(r.DeadLettered).toBe(0)
      expect(r.RetryCount).toBe(0)
      expect(r.LastError).toBeNull()
      expect(r.ReAdjudicatedAt).toBeTruthy()
      // Released for a VERDICT — never pre-judged as resolved.
      expect(r.Resolved).toBe(0)
    }
    expect(getReAdjudicationState().sweepCompletedAt).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// At-most-once — the infinite-requeue guard
// ---------------------------------------------------------------------------

describe('at-most-once per row', () => {
  it('never re-releases a row that was released and then re-parked', () => {
    const id = seedParked(GONE_ERROR)
    noteCloudEmitsRejectionCode()
    expect(runBacklogReAdjudication().released).toBe(1)

    // The cloud re-parked it (old cloud, or a genuinely different failure).
    memDb.prepare("UPDATE PendingSyncs SET DeadLettered = 1, LastError = ? WHERE id = ?").run(GONE_ERROR, id)

    // Reboot: in-memory caches cleared, durable flags survive.
    __resetReAdjudicationCachesForTests()
    memDb.prepare("DELETE FROM SyncMaintenanceFlags WHERE Key = 'backlog_readjudication_v1'").run()

    const res = runBacklogReAdjudication()
    expect(res.released).toBe(0)
    expect(row(id).DeadLettered).toBe(1)
    // The marker is what makes this durable — not an age or retry heuristic.
    expect(row(id).ReAdjudicatedAt).toBeTruthy()
  })

  it('early-outs on later boots once the sweep flag is banked', () => {
    noteCloudEmitsRejectionCode()
    runBacklogReAdjudication()
    __resetReAdjudicationCachesForTests()
    seedParked(GONE_ERROR) // arrives after the sweep completed
    expect(runBacklogReAdjudication().status).toBe('already_done')
  })

  it('is safe to interrupt: rows released before the interrupt stay marked', () => {
    const ids = [seedParked(GONE_ERROR, '2026-07-01 08:00:00'), seedParked(GONE_ERROR, '2026-07-02 08:00:00')]
    noteCloudEmitsRejectionCode()
    runBacklogReAdjudication()
    // Simulate a crash before the completion flag landed.
    memDb.prepare("DELETE FROM SyncMaintenanceFlags WHERE Key = 'backlog_readjudication_v1'").run()
    __resetReAdjudicationCachesForTests()
    // Re-running finds no candidates (both already marked) and banks completion.
    const res = runBacklogReAdjudication()
    expect(res.released).toBe(0)
    expect(res.status).toBe('complete')
    for (const id of ids) expect(row(id).ReAdjudicatedAt).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Selectivity + the no-delete invariant
// ---------------------------------------------------------------------------

describe('selectivity and data safety', () => {
  it('leaves parked rows that are NOT gone-on-cloud completely alone', () => {
    const conflict = seedParked(CONFLICT_ERROR)
    const spare = seedParked(SPARE_ERROR)
    noteCloudEmitsRejectionCode()
    runBacklogReAdjudication()
    for (const id of [conflict, spare]) {
      const r = row(id)
      expect(r.DeadLettered).toBe(1)
      expect(r.ReAdjudicatedAt).toBeNull()
      expect(r.RetryCount).toBe(10)
      expect(r.LastError).toBeTruthy()
    }
  })

  it('never bulk-marks a gone-on-cloud candidate Resolved on the string alone', () => {
    const id = seedParked(GONE_ERROR)
    noteCloudEmitsRejectionCode()
    runBacklogReAdjudication()
    // The whole point: the local classifier does not get to decide. The row goes
    // back to the cloud and the CLOUD decides.
    expect(row(id).Resolved).toBe(0)
    expect(row(id).Orphaned).toBe(0)
  })

  it('deletes nothing, ever', () => {
    seedParked(GONE_ERROR)
    seedParked(CONFLICT_ERROR)
    memDb.prepare("INSERT INTO PendingSyncs (IoId, TestResult, DeadLettered, Orphaned) VALUES (1, 'Passed', 1, 1)").run()
    const before = totalQueueRows()
    noteCloudEmitsRejectionCode()
    runBacklogReAdjudication()
    runBacklogReAdjudication()
    expect(totalQueueRows()).toBe(before)
  })

  it('preserves the queued test value through a release', () => {
    const id = seedParked(GONE_ERROR)
    noteCloudEmitsRejectionCode()
    runBacklogReAdjudication()
    expect(row(id).TestResult).toBe('Passed')
  })
})

// ---------------------------------------------------------------------------
// Task 2 — queue-age watchdog
// ---------------------------------------------------------------------------

describe('queue-age watchdog', () => {
  const NOW = new Date('2026-07-22T12:00:00.000Z')

  function seedActive(createdAt: string) {
    memDb
      .prepare("INSERT INTO PendingSyncs (IoId, TestResult, CreatedAt, DeadLettered) VALUES (1, 'Passed', ?, 0)")
      .run(createdAt)
  }

  it('defaults to a 15-minute threshold and reports it', () => {
    expect(QUEUE_AGE_WATCHDOG_MINUTES).toBe(15)
    expect(collectQueueStats(NOW).staleThresholdMin).toBe(15)
  })

  it('counts active rows past the threshold and ignores fresh ones', () => {
    seedActive('2026-07-22 11:59:00') // 1 min — fine
    seedActive('2026-07-22 11:50:00') // 10 min — fine
    seedActive('2026-07-22 11:30:00') // 30 min — STALE
    seedActive('2026-07-20 09:00:00') // 2 days — STALE
    const s = collectQueueStats(NOW)
    expect(s.active).toBe(4)
    expect(s.staleActive).toBe(2)
  })

  it('handles BOTH CreatedAt shapes — SQLite datetime and ISO-with-Z', () => {
    seedActive('2026-07-22 11:00:00')        // SQLite form, 60 min
    seedActive('2026-07-22T11:00:00.000Z')   // ISO form, same instant
    // A naive text comparison would misjudge the ISO row ('T' > ' ').
    expect(collectQueueStats(NOW).staleActive).toBe(2)
  })

  it('ignores parked and resolved rows — the watchdog is about work still in flight', () => {
    memDb.prepare("INSERT INTO PendingSyncs (IoId, TestResult, CreatedAt, DeadLettered) VALUES (1, 'Passed', '2026-07-01 08:00:00', 1)").run()
    memDb.prepare("INSERT INTO PendingSyncs (IoId, TestResult, CreatedAt, DeadLettered, Orphaned, Resolved) VALUES (1, 'Passed', '2026-07-01 08:00:00', 1, 1, 1)").run()
    const s = collectQueueStats(NOW)
    expect(s.staleActive).toBe(0)
    expect(s.parked).toBe(1) // the resolved one is excluded from parked too
  })

  it('reports zero on an empty queue rather than a false alarm', () => {
    const s = collectQueueStats(NOW)
    expect(s.staleActive).toBe(0)
    expect(s.oldestPendingAgeMin).toBe(0)
  })

  it('does not resolve, park, or delete anything — it only reports', () => {
    seedActive('2026-07-01 08:00:00')
    collectQueueStats(NOW)
    const r = memDb.prepare('SELECT DeadLettered, Resolved FROM PendingSyncs').get() as any
    expect(r.DeadLettered).toBe(0)
    expect(r.Resolved).toBe(0)
    expect(totalQueueRows()).toBe(1)
  })
})
