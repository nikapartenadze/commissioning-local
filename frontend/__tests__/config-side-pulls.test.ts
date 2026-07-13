/**
 * Test: config side-pulls helper (network / e-stop / safety / punchlist).
 *
 * Root cause this locks down (2026-07-01): the per-MCM pull's no-op short-circuit
 * keyed only on the IO hash and skipped these config pulls entirely, so FV/config
 * data went stale until a service restart. And safety was DELETEd by the pull but
 * never re-inserted (data loss). The fix extracts each config section into a
 * self-contained, idempotent delete-then-insert unit so it can run in BOTH the
 * full-pull and the no-op branch without duplicating rows or clobbering other MCMs.
 *
 * Contract under test:
 *  - Each section replaces ONLY the given subsystem's rows (scoped delete+insert).
 *  - Running twice yields the SAME rows (idempotent — no duplication).
 *  - Safety is actually re-pulled (regression guard for the deleted-never-repulled bug).
 *  - Another subsystem's rows are never touched.
 */
import { describe, it, expect, beforeEach } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3')
import { runConfigSidePulls, pullGuidedTaskStates } from '@/lib/cloud/config-side-pulls'

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE NetworkRings (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, Name TEXT, McmName TEXT, McmIp TEXT, McmTag TEXT);
  CREATE TABLE NetworkNodes (id INTEGER PRIMARY KEY AUTOINCREMENT, RingId INTEGER, Name TEXT, Position INTEGER, IpAddress TEXT, CableIn TEXT, CableOut TEXT, StatusTag TEXT, TotalPorts INTEGER);
  CREATE TABLE NetworkPorts (id INTEGER PRIMARY KEY AUTOINCREMENT, NodeId INTEGER, PortNumber INTEGER, CableLabel TEXT, DeviceName TEXT, DeviceType TEXT, DeviceIp TEXT, StatusTag TEXT, ParentPortId INTEGER);
  CREATE TABLE EStopZones (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, Name TEXT);
  CREATE TABLE EStopEpcs (id INTEGER PRIMARY KEY AUTOINCREMENT, ZoneId INTEGER, Name TEXT, CheckTag TEXT);
  CREATE TABLE EStopIoPoints (id INTEGER PRIMARY KEY AUTOINCREMENT, EpcId INTEGER, Tag TEXT);
  CREATE TABLE EStopVfds (id INTEGER PRIMARY KEY AUTOINCREMENT, EpcId INTEGER, Tag TEXT, StoTag TEXT, MustStop INTEGER);
  CREATE TABLE EStopRelatedEpcs (id INTEGER PRIMARY KEY AUTOINCREMENT, EpcId INTEGER, Tag TEXT, MustDrop INTEGER);
  CREATE TABLE SafetyZones (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, Name TEXT, StoSignal TEXT, BssTag TEXT);
  CREATE TABLE SafetyZoneDrives (id INTEGER PRIMARY KEY AUTOINCREMENT, ZoneId INTEGER, Name TEXT);
  CREATE TABLE SafetyOutputs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, Tag TEXT, Description TEXT, OutputType TEXT);
  CREATE TABLE Punchlists (id INTEGER PRIMARY KEY, Name TEXT, SubsystemId INTEGER);
  CREATE TABLE PunchlistItems (id INTEGER PRIMARY KEY AUTOINCREMENT, PunchlistId INTEGER, IoId INTEGER);
  CREATE TABLE GuidedTaskState (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER NOT NULL, TaskId TEXT NOT NULL, Status TEXT NOT NULL, Reason TEXT, ActorName TEXT, UpdatedAt TEXT DEFAULT (datetime('now')), UNIQUE(SubsystemId, TaskId));
  CREATE TABLE GuidedTaskStatePendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER NOT NULL, TaskId TEXT NOT NULL, Status TEXT NOT NULL, Reason TEXT, ActorName TEXT, UpdatedAt TEXT, CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0);
`)

// Stub cloud responses keyed by the path fragment the helper fetches.
// Punchlist ids are globally unique per subsystem in the cloud, so derive the
// id from the requested subsystemId to model that faithfully (a shared id would
// be an invalid cloud state, not a scoping bug in the helper).
function makeFetch(payloads: Record<string, unknown>) {
  return async (url: string) => {
    const key = Object.keys(payloads).find((k) => url.includes(k))
    let body = key ? payloads[key] : { success: false }
    if (key === '/api/sync/punchlists') {
      const sid = Number(new URL(url, 'http://x').searchParams.get('subsystemId'))
      body = { punchlists: [{ id: 500 + sid, name: `PL-${sid}`, ioIds: [11, 12] }] }
    }
    return { ok: true, json: async () => body } as unknown as Response
  }
}

const cloud = {
  '/api/network': {
    success: true,
    rings: [{ name: 'Ring A', mcmName: 'MCM16', mcmIp: '11.200.1.2', mcmTag: 'T',
      nodes: [{ name: 'N1', position: 1, ipAddress: '1.2.3.4', totalPorts: 28,
        ports: [{ portNumber: 1, deviceName: 'D1' }] }] }],
  },
  '/api/sync/estop': {
    success: true,
    zones: [{ name: 'Zone A', epcs: [{ name: 'EPC1', checkTag: 'C1',
      ioPoints: [{ tag: 'IO1' }], vfds: [{ tag: 'V1', stoTag: 'S1', mustStop: true }],
      // relatedEpcs (must-drop companion e-stops) cascade-delete with EStopEpcs;
      // the primary side-pull path must re-insert them (regression guard).
      relatedEpcs: [{ tag: 'REL1', mustDrop: true }, { tag: 'REL2', mustDrop: false }] }] }],
  },
  '/api/sync/safety': {
    success: true,
    zones: [{ name: 'SZ1', stoSignal: 'STO', bssTag: 'BSS', drives: [{ name: 'Drive1' }] }],
    outputs: [{ tag: 'OUT1', description: 'Horn', outputType: 'horn' }],
  },
  '/api/sync/punchlists': {
    punchlists: [{ id: 501, name: 'PL1', ioIds: [11, 12] }],
  },
}

const counts = (sid: number) => ({
  rings: (db.prepare('SELECT COUNT(*) c FROM NetworkRings WHERE SubsystemId=?').get(sid) as { c: number }).c,
  zones: (db.prepare('SELECT COUNT(*) c FROM EStopZones WHERE SubsystemId=?').get(sid) as { c: number }).c,
  safetyZones: (db.prepare('SELECT COUNT(*) c FROM SafetyZones WHERE SubsystemId=?').get(sid) as { c: number }).c,
  safetyOutputs: (db.prepare('SELECT COUNT(*) c FROM SafetyOutputs WHERE SubsystemId=?').get(sid) as { c: number }).c,
  punchlists: (db.prepare('SELECT COUNT(*) c FROM Punchlists WHERE SubsystemId=?').get(sid) as { c: number }).c,
})

describe('runConfigSidePulls', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM NetworkRings; DELETE FROM NetworkNodes; DELETE FROM NetworkPorts;
             DELETE FROM EStopZones; DELETE FROM EStopEpcs; DELETE FROM EStopIoPoints; DELETE FROM EStopVfds; DELETE FROM EStopRelatedEpcs;
             DELETE FROM SafetyZones; DELETE FROM SafetyZoneDrives; DELETE FROM SafetyOutputs;
             DELETE FROM Punchlists; DELETE FROM PunchlistItems;
             DELETE FROM GuidedTaskState; DELETE FROM GuidedTaskStatePendingSyncs;`)
  })

  const relatedEpcCount = () =>
    (db.prepare('SELECT COUNT(*) c FROM EStopRelatedEpcs').get() as { c: number }).c

  it('inserts network, e-stop, safety and punchlist rows for the subsystem', async () => {
    const res = await runConfigSidePulls(16, 'http://cloud', 'key', { db, fetchImpl: makeFetch(cloud) })
    expect(counts(16)).toEqual({ rings: 1, zones: 1, safetyZones: 1, safetyOutputs: 1, punchlists: 1 })
    // Safety is the regression guard for the deleted-never-repulled bug.
    expect(res.safetyPulled).toBe(1)
    expect(res.networkPulled).toBe(1)
    expect(res.estopPulled).toBe(1)
    // Related EPCs (must-drop companions) are re-inserted on the primary path.
    expect(relatedEpcCount()).toBe(2)
  })

  it('is idempotent — running twice does not duplicate rows', async () => {
    await runConfigSidePulls(16, 'http://cloud', 'key', { db, fetchImpl: makeFetch(cloud) })
    await runConfigSidePulls(16, 'http://cloud', 'key', { db, fetchImpl: makeFetch(cloud) })
    expect(counts(16)).toEqual({ rings: 1, zones: 1, safetyZones: 1, safetyOutputs: 1, punchlists: 1 })
    // Related EPCs are replaced, not duplicated, across repeated pulls.
    expect(relatedEpcCount()).toBe(2)
  })

  it('never touches another subsystem’s rows', async () => {
    // Seed subsystem 99 with pre-existing data via its own pull.
    await runConfigSidePulls(99, 'http://cloud', 'key', { db, fetchImpl: makeFetch(cloud) })
    // Now pull subsystem 16 — must not delete or duplicate 99's rows.
    await runConfigSidePulls(16, 'http://cloud', 'key', { db, fetchImpl: makeFetch(cloud) })
    expect(counts(99)).toEqual({ rings: 1, zones: 1, safetyZones: 1, safetyOutputs: 1, punchlists: 1 })
    expect(counts(16)).toEqual({ rings: 1, zones: 1, safetyZones: 1, safetyOutputs: 1, punchlists: 1 })
  })
})

// ── Guided task-state down-flow (skip / mark-done / cleared overrides) ────────
//
// Root cause this locks down (2026-07-13): GuidedTaskState pushed UP to the
// cloud since 2026-06-09 but was never pulled back ("field-authored — nothing
// to pull back"), so a fresh install or a peer laptop on the same subsystem
// showed skipped tasks as available again and manual completes as pending.
//
// Contract under test (mirrors the e-stop check down-flow):
//  - INSERT when local has no row; 'cleared' with no local row is a no-op.
//  - Apply only when cloud UpdatedAt is STRICTLY newer (ties keep local).
//  - 'cleared' deletes the local row (undo tombstone).
//  - Any task with an un-pushed local pending row is NEVER clobbered.
//  - Local marker-less datetime('now') timestamps compare as UTC vs cloud ISO.
describe('pullGuidedTaskStates', () => {
  beforeEach(() => {
    db.exec('DELETE FROM GuidedTaskState; DELETE FROM GuidedTaskStatePendingSyncs;')
  })

  const guidedFetch = (states: unknown[]) =>
    (async () => ({ ok: true, json: async () => ({ success: true, states }) })) as never

  const localRows = (sid: number) =>
    db.prepare('SELECT TaskId, Status, Reason, ActorName FROM GuidedTaskState WHERE SubsystemId=? ORDER BY TaskId').all(sid) as
      Array<{ TaskId: string; Status: string; Reason: string | null; ActorName: string | null }>

  it('inserts cloud states a fresh install has never seen', async () => {
    const applied = await pullGuidedTaskStates(16, 'http://cloud', 'key', {
      db,
      fetchImpl: guidedFetch([
        { taskId: 'network_loop:16', status: 'completed', reason: null, actorName: 'KK', updatedAt: '2026-07-13T08:00:00.000Z' },
        { taskId: 'io_check_safety:16:DEV1', status: 'skipped', reason: 'device removed', actorName: 'NP', updatedAt: '2026-07-13T08:01:00.000Z' },
      ]),
    })
    expect(applied).toBe(2)
    expect(localRows(16)).toEqual([
      { TaskId: 'io_check_safety:16:DEV1', Status: 'skipped', Reason: 'device removed', ActorName: 'NP' },
      { TaskId: 'network_loop:16', Status: 'completed', Reason: null, ActorName: 'KK' },
    ])
  })

  it('a cleared tombstone deletes the local row, and is a no-op when absent', async () => {
    db.prepare(`INSERT INTO GuidedTaskState (SubsystemId, TaskId, Status, UpdatedAt) VALUES (16, 'vfd_setup:16:V1', 'completed', '2026-07-13 07:00:00')`).run()
    const applied = await pullGuidedTaskStates(16, 'http://cloud', 'key', {
      db,
      fetchImpl: guidedFetch([
        { taskId: 'vfd_setup:16:V1', status: 'cleared', updatedAt: '2026-07-13T08:00:00.000Z' },
        { taskId: 'never_seen:16:X', status: 'cleared', updatedAt: '2026-07-13T08:00:00.000Z' },
      ]),
    })
    expect(applied).toBe(1)
    expect(localRows(16)).toEqual([])
  })

  it('never clobbers local rows that are same-or-newer (LWW, strict)', async () => {
    // Local marker-less UTC timestamp EQUAL to the cloud's → local wins.
    db.prepare(`INSERT INTO GuidedTaskState (SubsystemId, TaskId, Status, Reason, UpdatedAt) VALUES (16, 'T1', 'skipped', 'local reason', '2026-07-13 08:00:00')`).run()
    // Local NEWER than cloud → local wins.
    db.prepare(`INSERT INTO GuidedTaskState (SubsystemId, TaskId, Status, Reason, UpdatedAt) VALUES (16, 'T2', 'completed', NULL, '2026-07-13 09:00:00')`).run()
    const applied = await pullGuidedTaskStates(16, 'http://cloud', 'key', {
      db,
      fetchImpl: guidedFetch([
        { taskId: 'T1', status: 'completed', updatedAt: '2026-07-13T08:00:00.000Z' },
        { taskId: 'T2', status: 'cleared', updatedAt: '2026-07-13T08:30:00.000Z' },
      ]),
    })
    expect(applied).toBe(0)
    expect(localRows(16)).toEqual([
      { TaskId: 'T1', Status: 'skipped', Reason: 'local reason', ActorName: null },
      { TaskId: 'T2', Status: 'completed', Reason: null, ActorName: null },
    ])
  })

  it('applies a strictly newer cloud state over an older local row', async () => {
    db.prepare(`INSERT INTO GuidedTaskState (SubsystemId, TaskId, Status, Reason, UpdatedAt) VALUES (16, 'T1', 'skipped', 'old', '2026-07-13 07:00:00')`).run()
    const applied = await pullGuidedTaskStates(16, 'http://cloud', 'key', {
      db,
      fetchImpl: guidedFetch([
        { taskId: 'T1', status: 'completed', actorName: 'KK', updatedAt: '2026-07-13T08:00:00.000Z' },
      ]),
    })
    expect(applied).toBe(1)
    expect(localRows(16)).toEqual([{ TaskId: 'T1', Status: 'completed', Reason: null, ActorName: 'KK' }])
  })

  it('skips any task with an un-pushed local pending row — even a dead-lettered one', async () => {
    db.prepare(`INSERT INTO GuidedTaskState (SubsystemId, TaskId, Status, UpdatedAt) VALUES (16, 'T1', 'skipped', '2026-07-13 07:00:00')`).run()
    db.prepare(`INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status, DeadLettered) VALUES (16, 'T1', 'skipped', 1)`).run()
    const applied = await pullGuidedTaskStates(16, 'http://cloud', 'key', {
      db,
      fetchImpl: guidedFetch([
        { taskId: 'T1', status: 'cleared', updatedAt: '2099-01-01T00:00:00.000Z' },
      ]),
    })
    expect(applied).toBe(0)
    expect(localRows(16)).toEqual([{ TaskId: 'T1', Status: 'skipped', Reason: null, ActorName: null }])
  })

  it('ignores malformed or unknown-status states and never throws on fetch failure', async () => {
    const applied = await pullGuidedTaskStates(16, 'http://cloud', 'key', {
      db,
      fetchImpl: guidedFetch([
        { taskId: '', status: 'completed', updatedAt: '2026-07-13T08:00:00.000Z' },
        { taskId: 'T1', status: 'exploded', updatedAt: '2026-07-13T08:00:00.000Z' },
        { status: 'completed' },
      ]),
    })
    expect(applied).toBe(0)
    expect(localRows(16)).toEqual([])

    const failing = await pullGuidedTaskStates(16, 'http://cloud', 'key', {
      db,
      fetchImpl: (async () => { throw new Error('boom') }) as never,
    })
    expect(failing).toBe(0)
  })

  it('is idempotent and scoped — re-pull applies nothing, other subsystems untouched', async () => {
    db.prepare(`INSERT INTO GuidedTaskState (SubsystemId, TaskId, Status, UpdatedAt) VALUES (99, 'T1', 'completed', '2026-07-13 07:00:00')`).run()
    const states = [{ taskId: 'T1', status: 'skipped', reason: 'r', updatedAt: '2026-07-13T08:00:00.000Z' }]
    const first = await pullGuidedTaskStates(16, 'http://cloud', 'key', { db, fetchImpl: guidedFetch(states) })
    const second = await pullGuidedTaskStates(16, 'http://cloud', 'key', { db, fetchImpl: guidedFetch(states) })
    expect(first).toBe(1)
    expect(second).toBe(0) // same updatedAt → strict LWW keeps the applied row
    expect(localRows(16)).toEqual([{ TaskId: 'T1', Status: 'skipped', Reason: 'r', ActorName: null }])
    expect(localRows(99)).toEqual([{ TaskId: 'T1', Status: 'completed', Reason: null, ActorName: null }])
  })
})
