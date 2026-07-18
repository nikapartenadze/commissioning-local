import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Per-type pull ISOLATION — the "don't accidentally wipe other people's work"
 * guarantee behind the modal's per-section Pull buttons.
 *
 * Each standalone section pull (pull-safety / pull-network / pull-punchlists /
 * pull-estop) must rewrite ONLY its own section for the requested subsystem and
 * leave every OTHER section — and every OTHER subsystem's rows in the same
 * section — untouched. Real route handlers run against a real in-memory SQLite;
 * only the cloud fetch + config are mocked (same style as pull-l2-nondestructive).
 */

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE SafetyZones (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, Name TEXT, StoSignal TEXT, BssTag TEXT);
    CREATE TABLE SafetyZoneDrives (id INTEGER PRIMARY KEY AUTOINCREMENT, ZoneId INTEGER, Name TEXT);
    CREATE TABLE SafetyOutputs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, Tag TEXT, Description TEXT, OutputType TEXT);
    CREATE TABLE NetworkRings (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, Name TEXT, McmName TEXT, McmIp TEXT, McmTag TEXT);
    CREATE TABLE NetworkNodes (id INTEGER PRIMARY KEY AUTOINCREMENT, RingId INTEGER, Name TEXT, Position INTEGER, IpAddress TEXT, CableIn TEXT, CableOut TEXT, StatusTag TEXT, TotalPorts INTEGER);
    CREATE TABLE NetworkPorts (id INTEGER PRIMARY KEY AUTOINCREMENT, NodeId INTEGER, PortNumber INTEGER, CableLabel TEXT, DeviceName TEXT, DeviceIp TEXT, DeviceType TEXT, StatusTag TEXT, ParentPortId INTEGER);
    CREATE TABLE Punchlists (id INTEGER PRIMARY KEY, Name TEXT, SubsystemId INTEGER);
    CREATE TABLE PunchlistItems (id INTEGER PRIMARY KEY AUTOINCREMENT, PunchlistId INTEGER, IoId INTEGER);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb, extractDeviceName: () => null }))
vi.mock('@/lib/config', () => ({
  configService: { getConfig: vi.fn(async () => ({ remoteUrl: 'http://cloud', apiPassword: 'key', subsystemId: '40' })) },
}))

let cloudPayload: any
global.fetch = vi.fn(async () => ({
  ok: true, status: 200, statusText: 'OK',
  json: async () => cloudPayload,
  text: async () => JSON.stringify(cloudPayload),
})) as any

import { POST as pullSafety } from '@/app/api/cloud/pull-safety/route'
import { POST as pullNetwork } from '@/app/api/cloud/pull-network/route'

const SID = 40
const OTHER = 99

function run(handler: any, payload: any, subsystemId = SID) {
  cloudPayload = payload
  const req: any = { body: { subsystemId } }
  const res: any = {
    statusCode: 200, body: undefined,
    status(c: number) { this.statusCode = c; return this },
    json(o: any) { this.body = o; return this },
  }
  return handler(req, res).then(() => res)
}

const count = (sql: string, ...args: any[]) => (memDb.prepare(sql).get(...args) as { c: number }).c

describe('per-type pull isolation', () => {
  beforeEach(() => {
    memDb.exec(`DELETE FROM SafetyZones; DELETE FROM SafetyZoneDrives; DELETE FROM SafetyOutputs;
      DELETE FROM NetworkRings; DELETE FROM NetworkNodes; DELETE FROM NetworkPorts;
      DELETE FROM Punchlists; DELETE FROM PunchlistItems;`)
    // Seed one subsystem with rows in THREE sections, plus another subsystem's
    // safety + network (the cross-MCM "other people's work").
    memDb.prepare('INSERT INTO SafetyZones (SubsystemId, Name) VALUES (?, ?)').run(SID, 'OLD_SAFETY_40')
    memDb.prepare('INSERT INTO SafetyZones (SubsystemId, Name) VALUES (?, ?)').run(OTHER, 'SAFETY_99')
    memDb.prepare('INSERT INTO NetworkRings (SubsystemId, Name, McmName) VALUES (?, ?, ?)').run(SID, 'RING_40', 'MCM40')
    memDb.prepare('INSERT INTO NetworkRings (SubsystemId, Name, McmName) VALUES (?, ?, ?)').run(OTHER, 'RING_99', 'MCM99')
    memDb.prepare('INSERT INTO Punchlists (id, Name, SubsystemId) VALUES (?, ?, ?)').run(1, 'PL_40', SID)
    vi.clearAllMocks()
  })

  it('pull-safety replaces only safety for this subsystem; network + punchlists + other MCM safety untouched', async () => {
    const res = await run(pullSafety, {
      success: true,
      zones: [{ name: 'NEW_SAFETY_40', stoSignal: 'STO1', bssTag: 'BSS1', drives: [{ name: 'DRV1' }] }],
      outputs: [{ tag: 'OUT1', description: 'd', outputType: 't' }],
    })
    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    // Safety for THIS subsystem replaced with the cloud set.
    expect(count('SELECT COUNT(*) c FROM SafetyZones WHERE SubsystemId = ? AND Name = ?', SID, 'NEW_SAFETY_40')).toBe(1)
    expect(count('SELECT COUNT(*) c FROM SafetyZones WHERE SubsystemId = ? AND Name = ?', SID, 'OLD_SAFETY_40')).toBe(0)
    // OTHER subsystem's safety untouched (scoped delete).
    expect(count('SELECT COUNT(*) c FROM SafetyZones WHERE SubsystemId = ?', OTHER)).toBe(1)
    // OTHER sections for THIS subsystem untouched.
    expect(count('SELECT COUNT(*) c FROM NetworkRings WHERE SubsystemId = ?', SID)).toBe(1)
    expect(count('SELECT COUNT(*) c FROM Punchlists WHERE SubsystemId = ?', SID)).toBe(1)
  })

  it('pull-network replaces only network for this subsystem; safety + punchlists + other MCM network untouched', async () => {
    const res = await run(pullNetwork, {
      success: true,
      rings: [{ name: 'NEW_RING_40', mcmName: 'MCM40', nodes: [{ name: 'N1', position: 1, ports: [{ portNumber: 1, deviceName: 'DEV' }] }] }],
    })
    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    expect(count('SELECT COUNT(*) c FROM NetworkRings WHERE SubsystemId = ? AND Name = ?', SID, 'NEW_RING_40')).toBe(1)
    expect(count('SELECT COUNT(*) c FROM NetworkRings WHERE SubsystemId = ? AND Name = ?', SID, 'RING_40')).toBe(0)
    expect(count('SELECT COUNT(*) c FROM NetworkRings WHERE SubsystemId = ?', OTHER)).toBe(1) // other MCM safe
    expect(count('SELECT COUNT(*) c FROM SafetyZones WHERE SubsystemId = ?', SID)).toBe(1)    // safety untouched
    expect(count('SELECT COUNT(*) c FROM Punchlists WHERE SubsystemId = ?', SID)).toBe(1)     // punchlists untouched
  })

  it('an empty cloud response keeps existing local rows (never blanks a section)', async () => {
    const res = await run(pullSafety, { success: true, zones: [], outputs: [] })
    expect(res.statusCode).toBe(200)
    // Nothing on the cloud → local safety preserved, not wiped.
    expect(count('SELECT COUNT(*) c FROM SafetyZones WHERE SubsystemId = ? AND Name = ?', SID, 'OLD_SAFETY_40')).toBe(1)
  })
})
