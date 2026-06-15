/**
 * Regression: GET /api/estop/status must scope EStopZones to the requested
 * subsystemId.
 *
 * Bug (CDW5, multi-MCM central tool): the per-MCM pull
 * (/api/mcm/[subsystemId]/pull) deletes+inserts zones scoped BY subsystem, so
 * the local DB legitimately holds several MCMs' zones at once. But the status
 * read used a bare `SELECT * FROM EStopZones` (no WHERE), so viewing MCM11's
 * E-Stop tab also showed MCM16's zone (and vice-versa) — "duplicate values,
 * both MCMs displayed". The cloud data itself was clean (verified in prod).
 *
 * Contract:
 *   - ?subsystemId=47  -> only subsystem 47's zones
 *   - no subsystemId   -> all zones (back-compat for legacy single-MCM tablets)
 *
 * Setup mirrors estop-check-sync.test.ts: hoisted in-memory better-sqlite3 with
 * the columns the route reads; PLC + mcm-registry stubbed so no hardware path
 * runs (zones are returned regardless of connection).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE EStopZones (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, Name TEXT NOT NULL);
    CREATE TABLE EStopEpcs (id INTEGER PRIMARY KEY AUTOINCREMENT, ZoneId INTEGER NOT NULL, Name TEXT NOT NULL, CheckTag TEXT NOT NULL);
    CREATE TABLE EStopIoPoints (id INTEGER PRIMARY KEY AUTOINCREMENT, EpcId INTEGER NOT NULL, Tag TEXT NOT NULL);
    CREATE TABLE EStopVfds (id INTEGER PRIMARY KEY AUTOINCREMENT, EpcId INTEGER NOT NULL, Tag TEXT, StoTag TEXT, MustStop INTEGER);
    CREATE TABLE EStopRelatedEpcs (id INTEGER PRIMARY KEY AUTOINCREMENT, EpcId INTEGER NOT NULL, Tag TEXT, MustDrop INTEGER);
    CREATE TABLE EStopEpcChecks (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER NOT NULL, ZoneName TEXT NOT NULL, CheckTag TEXT NOT NULL, CheckType TEXT, Result TEXT, Comments TEXT, FailureMode TEXT, TestedBy TEXT, TestedAt TEXT);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
vi.mock('@/lib/plc-client-manager', () => ({
  hasPlcClient: () => false,
  getPlcClient: () => ({ isConnected: false }),
}))
vi.mock('@/lib/mcm-registry', () => ({
  hasMcm: () => false,
  readTypedTagsForMcm: async () => ({ connected: false, results: [] }),
}))

import { GET } from '@/app/api/estop/status/route'

function seedZone(subsystemId: number, name: string) {
  const z = memDb.prepare('INSERT INTO EStopZones (SubsystemId, Name) VALUES (?, ?)').run(subsystemId, name)
  memDb.prepare('INSERT INTO EStopEpcs (ZoneId, Name, CheckTag) VALUES (?, ?, ?)').run(z.lastInsertRowid, `${name}_EPC1`, `${name}_EPC1_Check`)
}

function fakeRes() {
  const out: any = { statusCode: 200, body: null }
  const res: any = {
    status(c: number) { out.statusCode = c; return res },
    json(b: any) { out.body = b; return res },
  }
  return { res, out }
}

async function callStatus(query: Record<string, string> = {}) {
  const { res, out } = fakeRes()
  await GET({ query } as any, res)
  return out.body
}

describe('GET /api/estop/status — subsystem scoping', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM EStopEpcs; DELETE FROM EStopZones;')
    // MCM11 (sid 47): 6 zones; MCM16 (sid 52): 1 zone — mirrors prod CDW5.
    for (let i = 1; i <= 6; i++) seedZone(47, `MCM11_ZONE_0${i}`)
    seedZone(52, 'MCM16_ZONE_01')
  })

  it('returns ONLY the requested subsystem\'s zones', async () => {
    const body = await callStatus({ subsystemId: '47' })
    expect(body.success).toBe(true)
    const names: string[] = body.zones.map((z: any) => z.name)
    expect(names).toHaveLength(6)
    expect(names.every((n) => n.startsWith('MCM11_'))).toBe(true)
    expect(names.some((n) => n.startsWith('MCM16_'))).toBe(false)
  })

  it('does not leak another MCM\'s zone into a single-zone MCM view', async () => {
    const body = await callStatus({ subsystemId: '52' })
    const names: string[] = body.zones.map((z: any) => z.name)
    expect(names).toEqual(['MCM16_ZONE_01'])
  })

  it('returns all zones when no subsystemId is given (legacy single-MCM tablet)', async () => {
    const body = await callStatus({})
    expect(body.zones).toHaveLength(7)
  })
})
