/**
 * Test: destructive pull blocks on the E-stop-check and guided-task queues.
 *
 * DATA-LOSS hole: the full-pull routes wipe-and-reinsert tables (the global
 * route DELETEs EStopZones/EStopEpcs/… which cascades E-stop check data) and
 * only BLOCKED the pull on unsynced IO (PendingSyncs) / L2 (L2PendingSyncs) /
 * change requests. They did NOT count the EStopCheckPendingSyncs or
 * GuidedTaskStatePendingSyncs queues, so a pull could erase unsynced E-stop
 * and guided-task results.
 *
 * These tests assert the queue-counting contract the routes rely on, against a
 * real in-memory DB carrying the verbatim DDL (mirrors __tests__/estop-check-
 * sync.test.ts). The route block condition sums these counts: > 0 ⇒ blocked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3')

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE Ios (
    id INTEGER PRIMARY KEY,
    Name TEXT,
    SubsystemId INTEGER
  , CloudRemoved INTEGER DEFAULT 0);
  CREATE TABLE PendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    IoId INTEGER NOT NULL,
    DeadLettered INTEGER DEFAULT 0
  );
  CREATE TABLE L2PendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    DeadLettered INTEGER DEFAULT 0
  );
  CREATE TABLE ChangeRequests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    Status TEXT,
    CloudId INTEGER
  );
  CREATE TABLE EStopCheckPendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    SubsystemId INTEGER NOT NULL,
    ZoneName TEXT NOT NULL,
    CheckTag TEXT NOT NULL,
    CheckType TEXT NOT NULL DEFAULT 'preliminary'
  );
  CREATE TABLE GuidedTaskStatePendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    SubsystemId INTEGER NOT NULL,
    TaskId TEXT NOT NULL,
    Status TEXT NOT NULL
  );
`)

// The exact counts the GLOBAL route (app/api/cloud/pull/route.ts) computes.
function globalPendingTotal() {
  const pendingIoActive = (db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE DeadLettered = 0').get() as { cnt: number }).cnt
  const pendingIoParked = (db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE DeadLettered = 1').get() as { cnt: number }).cnt
  const pendingL2Count = (db.prepare('SELECT COUNT(*) as cnt FROM L2PendingSyncs WHERE DeadLettered = 0').get() as { cnt: number }).cnt
  const pendingChangeRequestCount = (db.prepare("SELECT COUNT(*) as cnt FROM ChangeRequests WHERE Status = 'pending' AND CloudId IS NULL").get() as { cnt: number }).cnt
  const pendingEStopCheckCount = (db.prepare('SELECT COUNT(*) as cnt FROM EStopCheckPendingSyncs').get() as { cnt: number }).cnt
  const pendingGuidedTaskCount = (db.prepare('SELECT COUNT(*) as cnt FROM GuidedTaskStatePendingSyncs').get() as { cnt: number }).cnt
  return pendingIoActive + pendingIoParked + pendingL2Count + pendingChangeRequestCount + pendingEStopCheckCount + pendingGuidedTaskCount
}

// The exact subsystem-scoped counts the per-MCM route
// (app/api/mcm/[subsystemId]/pull/route.ts) computes.
function mcmPendingTotal(subsystemId: number) {
  const pendingActive = (db.prepare(
    `SELECT COUNT(*) as cnt FROM PendingSyncs ps JOIN Ios i ON i.id = ps.IoId WHERE i.SubsystemId = ? AND ps.DeadLettered = 0`,
  ).get(subsystemId) as { cnt: number }).cnt
  const pendingParked = (db.prepare(
    `SELECT COUNT(*) as cnt FROM PendingSyncs ps JOIN Ios i ON i.id = ps.IoId WHERE i.SubsystemId = ? AND ps.DeadLettered = 1`,
  ).get(subsystemId) as { cnt: number }).cnt
  const pendingEStopCheck = (db.prepare(
    'SELECT COUNT(*) as cnt FROM EStopCheckPendingSyncs WHERE SubsystemId = ?',
  ).get(subsystemId) as { cnt: number }).cnt
  const pendingGuidedTask = (db.prepare(
    'SELECT COUNT(*) as cnt FROM GuidedTaskStatePendingSyncs WHERE SubsystemId = ?',
  ).get(subsystemId) as { cnt: number }).cnt
  return pendingActive + pendingParked + pendingEStopCheck + pendingGuidedTask
}

describe('global pull block — E-stop / guided queues', () => {
  beforeEach(() => {
    db.exec('DELETE FROM PendingSyncs; DELETE FROM L2PendingSyncs; DELETE FROM ChangeRequests; DELETE FROM EStopCheckPendingSyncs; DELETE FROM GuidedTaskStatePendingSyncs;')
  })

  it('does not block when every queue (incl. estop + guided) is clean', () => {
    expect(globalPendingTotal()).toBe(0)
  })

  it('blocks the pull when an unsynced E-stop check exists', () => {
    db.prepare(`INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CheckTag) VALUES (16, 'Zone A', 'EPC_01_Check')`).run()
    expect(globalPendingTotal()).toBeGreaterThan(0)
  })

  it('blocks the pull when an unsynced guided-task state exists', () => {
    db.prepare(`INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status) VALUES (16, 'task-1', 'skipped')`).run()
    expect(globalPendingTotal()).toBeGreaterThan(0)
  })
})

describe('per-MCM pull block — E-stop / guided queues (subsystem-scoped)', () => {
  beforeEach(() => {
    db.exec('DELETE FROM Ios; DELETE FROM PendingSyncs; DELETE FROM EStopCheckPendingSyncs; DELETE FROM GuidedTaskStatePendingSyncs;')
  })

  it('does not block when this subsystem has no pending work', () => {
    db.prepare(`INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CheckTag) VALUES (99, 'Zone A', 'EPC_01_Check')`).run()
    db.prepare(`INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status) VALUES (99, 'task-1', 'skipped')`).run()
    // Other subsystem's pending work must not block subsystem 16.
    expect(mcmPendingTotal(16)).toBe(0)
  })

  it('blocks subsystem 16 when it has an unsynced E-stop check', () => {
    db.prepare(`INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CheckTag) VALUES (16, 'Zone A', 'EPC_01_Check')`).run()
    expect(mcmPendingTotal(16)).toBeGreaterThan(0)
  })

  it('blocks subsystem 16 when it has an unsynced guided-task state', () => {
    db.prepare(`INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status) VALUES (16, 'task-1', 'skipped')`).run()
    expect(mcmPendingTotal(16)).toBeGreaterThan(0)
  })
})
