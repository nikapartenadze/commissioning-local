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
import { runConfigSidePulls } from '@/lib/cloud/config-side-pulls'

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
             DELETE FROM Punchlists; DELETE FROM PunchlistItems;`)
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
