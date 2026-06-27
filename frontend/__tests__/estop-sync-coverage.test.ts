/**
 * E-stop sync — BOTH directions, coverage for the previously-untested half.
 *
 * E-stop data crosses the local/cloud boundary in two ways:
 *
 *   field→cloud:  EPC pass/fail RESULTS are pushed (enqueueEstopCheckSync →
 *                 POST /api/sync/estop-checks). Already covered exhaustively by
 *                 __tests__/estop-check-sync.test.ts (pending-sync, retry,
 *                 result normalization, dual checkType). NOT duplicated here.
 *
 *   cloud→field:  the e-stop DEFINITIONS (zones → EPCs → IO points / VFDs /
 *                 related EPCs) are PULLED (POST /api/cloud/pull-estop → GET
 *                 {remoteUrl}/api/sync/estop?subsystemId=…). This direction had
 *                 NO unit coverage. This file pins it.
 *
 * The pull is DESTRUCTIVE-then-rebuild: it `DELETE FROM EStopZones` (the legacy
 * single-MCM route wipes globally, on purpose — the per-MCM route scopes it)
 * and re-inserts the cloud's tree. Risks worth reding CI on a regression:
 *
 *   - the full zone→epc→{ioPoint,vfd,relatedEpc} tree is rebuilt with the right
 *     parent ids and MustStop/MustDrop coerced to 0/1;
 *   - a misconfig (no remoteUrl / no subsystemId) is a 400 and does NOT fetch;
 *   - a cloud 404, an empty/`success:false` body, or zero zones is a benign
 *     no-op that does NOT wipe the local definitions (incident-shaped: a cloud
 *     blip must not erase the field tool's e-stop tree);
 *   - a non-OK (non-404) status is a 502 and also preserves local data.
 *
 * Pattern mirrors __tests__/vfd-addressed-sync.test.ts: the @/lib/db-sqlite
 * singleton is mocked to a throwaway in-memory SQLite, config is mocked, and the
 * REAL route handler runs against a mocked global fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  return { memDb: new Database(':memory:') }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))

// Mutable config the route reads through configService.getConfig().
const cfg: { remoteUrl: any; apiPassword: any; subsystemId: any } = {
  remoteUrl: 'https://cloud.example',
  apiPassword: 'secret-key',
  subsystemId: 47,
}
vi.mock('@/lib/config', () => ({
  configService: { getConfig: vi.fn(async () => cfg) },
}))

import { POST } from '@/app/api/cloud/pull-estop/route'

// Verbatim e-stop DDL from lib/db-sqlite.ts (the columns/constraints the route
// inserts against). PK ids + FK shape matter: the route threads lastInsertRowid
// from zone→epc→children.
function buildSchema() {
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS EStopZones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER,
      Name TEXT NOT NULL,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS EStopEpcs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ZoneId INTEGER NOT NULL REFERENCES EStopZones(id) ON DELETE CASCADE,
      Name TEXT NOT NULL,
      CheckTag TEXT NOT NULL,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS EStopIoPoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      EpcId INTEGER NOT NULL REFERENCES EStopEpcs(id) ON DELETE CASCADE,
      Tag TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS EStopVfds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      EpcId INTEGER NOT NULL REFERENCES EStopEpcs(id) ON DELETE CASCADE,
      Tag TEXT NOT NULL,
      StoTag TEXT NOT NULL,
      MustStop INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS EStopRelatedEpcs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      EpcId INTEGER NOT NULL REFERENCES EStopEpcs(id) ON DELETE CASCADE,
      Tag TEXT NOT NULL,
      MustDrop INTEGER NOT NULL
    );
  `)
}

function fakeRes() {
  const out: { statusCode: number; body: any } = { statusCode: 200, body: null }
  const res: any = {
    status(c: number) { out.statusCode = c; return res },
    json(b: any) { out.body = b; return res },
  }
  return { res, out }
}

async function callPull() {
  const { res, out } = fakeRes()
  await POST({} as any, res)
  return out
}

// Seed one zone so the "did NOT wipe" assertions have something to protect.
function seedLocalZone(name = 'EXISTING_ZONE') {
  const z = memDb.prepare('INSERT INTO EStopZones (SubsystemId, Name) VALUES (?, ?)').run(47, name)
  memDb.prepare('INSERT INTO EStopEpcs (ZoneId, Name, CheckTag) VALUES (?, ?, ?)')
    .run(z.lastInsertRowid, `${name}_EPC`, `${name}_EPC_Check`)
}

const countZones = () => (memDb.prepare('SELECT COUNT(*) c FROM EStopZones').get() as any).c

beforeEach(() => {
  memDb.exec('DROP TABLE IF EXISTS EStopRelatedEpcs; DROP TABLE IF EXISTS EStopVfds; DROP TABLE IF EXISTS EStopIoPoints; DROP TABLE IF EXISTS EStopEpcs; DROP TABLE IF EXISTS EStopZones;')
  buildSchema()
  cfg.remoteUrl = 'https://cloud.example'
  cfg.apiPassword = 'secret-key'
  cfg.subsystemId = 47
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /api/cloud/pull-estop — cloud→field e-stop DEFINITIONS pull', () => {
  it('rebuilds the full zone→epc→{ioPoint,vfd,relatedEpc} tree with correct parent ids', async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => {
      // Hits the contracted, subsystem-scoped cloud endpoint with X-API-Key.
      expect(url).toBe('https://cloud.example/api/sync/estop?subsystemId=47')
      expect(init.headers['X-API-Key']).toBe('secret-key')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          zones: [
            {
              name: 'ZONE_A',
              epcs: [
                {
                  name: 'EPC_A1', checkTag: 'EPC_A1_Check',
                  ioPoints: [{ tag: 'IO_A1_1' }, { tag: 'IO_A1_2' }],
                  vfds: [{ tag: 'VFD_A1', stoTag: 'VFD_A1_STO', mustStop: true }],
                  relatedEpcs: [{ tag: 'REL_A1', mustDrop: true }],
                },
                { name: 'EPC_A2', checkTag: 'EPC_A2_Check', ioPoints: [{ tag: 'IO_A2_1' }] },
              ],
            },
            { name: 'ZONE_B', epcs: [{ name: 'EPC_B1', checkTag: 'EPC_B1_Check' }] },
          ],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await callPull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.statusCode).toBe(200)
    expect(out.body).toMatchObject({ success: true, zones: 2, epcs: 3, ioPoints: 3, vfds: 1, relatedEpcs: 1 })

    // Zones are stamped with the configured subsystem.
    const zones = memDb.prepare('SELECT id, SubsystemId, Name FROM EStopZones ORDER BY Name').all() as any[]
    expect(zones.map(z => z.Name)).toEqual(['ZONE_A', 'ZONE_B'])
    expect(zones.every(z => z.SubsystemId === 47)).toBe(true)

    // EPCs hang off the right zone.
    const zoneA = zones.find(z => z.Name === 'ZONE_A')
    const epcsA = memDb.prepare('SELECT id, Name, CheckTag FROM EStopEpcs WHERE ZoneId = ? ORDER BY Name').all(zoneA.id) as any[]
    expect(epcsA.map(e => e.Name)).toEqual(['EPC_A1', 'EPC_A2'])

    // Children hang off the right EPC, and MustStop/MustDrop are coerced to 1.
    const epcA1 = epcsA.find(e => e.Name === 'EPC_A1')
    const ios = memDb.prepare('SELECT Tag FROM EStopIoPoints WHERE EpcId = ? ORDER BY Tag').all(epcA1.id) as any[]
    expect(ios.map(i => i.Tag)).toEqual(['IO_A1_1', 'IO_A1_2'])
    const vfd = memDb.prepare('SELECT Tag, StoTag, MustStop FROM EStopVfds WHERE EpcId = ?').get(epcA1.id) as any
    expect(vfd).toMatchObject({ Tag: 'VFD_A1', StoTag: 'VFD_A1_STO', MustStop: 1 })
    const rel = memDb.prepare('SELECT Tag, MustDrop FROM EStopRelatedEpcs WHERE EpcId = ?').get(epcA1.id) as any
    expect(rel).toMatchObject({ Tag: 'REL_A1', MustDrop: 1 })
  })

  it('coerces falsy mustStop/mustDrop to 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        success: true,
        zones: [{
          name: 'Z', epcs: [{
            name: 'E', checkTag: 'E_Check',
            vfds: [{ tag: 'V', stoTag: 'V_STO', mustStop: false }],
            relatedEpcs: [{ tag: 'R', mustDrop: false }],
          }],
        }],
      }),
    })))
    const out = await callPull()
    expect(out.statusCode).toBe(200)
    expect((memDb.prepare('SELECT MustStop FROM EStopVfds').get() as any).MustStop).toBe(0)
    expect((memDb.prepare('SELECT MustDrop FROM EStopRelatedEpcs').get() as any).MustDrop).toBe(0)
  })

  it('replaces the local tree: a fresh pull wipes the prior zones first', async () => {
    seedLocalZone('OLD_ZONE')
    seedLocalZone('OLD_ZONE_2')
    expect(countZones()).toBe(2)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ success: true, zones: [{ name: 'NEW_ZONE', epcs: [] }] }),
    })))
    const out = await callPull()
    expect(out.statusCode).toBe(200)
    expect(out.body.zones).toBe(1)
    expect(memDb.prepare('SELECT Name FROM EStopZones').all().map((z: any) => z.Name)).toEqual(['NEW_ZONE'])
  })

  it('400s and does NOT fetch when remoteUrl is missing', async () => {
    cfg.remoteUrl = ''
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const out = await callPull()
    expect(out.statusCode).toBe(400)
    expect(out.body.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400s and does NOT fetch when subsystemId is missing', async () => {
    cfg.subsystemId = undefined
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const out = await callPull()
    expect(out.statusCode).toBe(400)
    expect(out.body.success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('parses a string subsystemId from config into the query', async () => {
    cfg.subsystemId = '52'
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://cloud.example/api/sync/estop?subsystemId=52')
      return { ok: true, status: 200, json: async () => ({ success: true, zones: [{ name: 'Z', epcs: [] }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await callPull()
    expect(out.statusCode).toBe(200)
    expect((memDb.prepare('SELECT SubsystemId FROM EStopZones').get() as any).SubsystemId).toBe(52)
  })

  it('treats a cloud 404 as a benign no-op and does NOT wipe local definitions', async () => {
    seedLocalZone('KEEP_ZONE')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    const out = await callPull()
    expect(out.statusCode).toBe(200)
    expect(out.body).toMatchObject({ success: true, zones: 0 })
    // Local tree survived — a cloud "no data" must not erase the field tool's zones.
    expect(memDb.prepare('SELECT Name FROM EStopZones').all().map((z: any) => z.Name)).toEqual(['KEEP_ZONE'])
  })

  it('502s on a non-OK (non-404) cloud status and does NOT wipe local definitions', async () => {
    seedLocalZone('KEEP_ZONE')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const out = await callPull()
    expect(out.statusCode).toBe(502)
    expect(out.body.success).toBe(false)
    expect(memDb.prepare('SELECT Name FROM EStopZones').all().map((z: any) => z.Name)).toEqual(['KEEP_ZONE'])
  })

  it('treats an empty / zero-zone payload as a no-op WITHOUT clearing local data', async () => {
    seedLocalZone('KEEP_ZONE')
    // success:true but no zones — the route returns early BEFORE the DELETE.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, zones: [] }) })))
    const out = await callPull()
    expect(out.statusCode).toBe(200)
    expect(out.body).toMatchObject({ success: true, zones: 0 })
    expect(countZones()).toBe(1)
  })

  it('treats success:false as a no-op WITHOUT clearing local data', async () => {
    seedLocalZone('KEEP_ZONE')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: false }) })))
    const out = await callPull()
    expect(out.statusCode).toBe(200)
    expect(out.body).toMatchObject({ success: true, zones: 0 })
    expect(countZones()).toBe(1)
  })

  it('500s and does NOT wipe local data when fetch throws (network down)', async () => {
    seedLocalZone('KEEP_ZONE')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const out = await callPull()
    expect(out.statusCode).toBe(500)
    expect(out.body.success).toBe(false)
    expect(memDb.prepare('SELECT Name FROM EStopZones').all().map((z: any) => z.Name)).toEqual(['KEEP_ZONE'])
  })
})
