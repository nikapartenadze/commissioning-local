/**
 * Cloud→field NETWORK TOPOLOGY sync — pull + cloud-authoritative replace.
 *
 * Network topology (rings → nodes → ports/devices) is a CLOUD-OWNED definition:
 * the cloud app builds the ring/node/device tree and the field tool only PULLS
 * it (live PLC status tags are pushed UP separately by auto-sync; the topology
 * SHAPE only ever flows DOWN). The proven sync path is the Express route
 * handler `POST /api/cloud/pull-network` (app/api/cloud/pull-network/route.ts):
 * it reads remoteUrl/subsystemId from config, fetches GET {remote}/api/network,
 * then DELETE-then-inserts the local NetworkRings/NetworkNodes/NetworkPorts tree
 * for that subsystem. The FK cascade (ON DELETE CASCADE from Rings→Nodes→Ports)
 * is what makes the single `DELETE FROM NetworkRings WHERE SubsystemId=?` a full
 * subtree wipe — so the test pins that the cascade is actually wired.
 *
 * Risks worth pinning so a regression reds CI:
 *
 *   - the replace is CLOUD-AUTHORITATIVE per subsystem: rings the cloud no
 *     longer lists must be gone after a re-pull, not left stale (the MCM08/MCM11
 *     "stale local state survives a cloud change" incident class).
 *   - it must only touch the TARGET subsystem (no cross-MCM topology wipe).
 *   - parent/child sub-port links are remapped from CLOUD ids to LOCAL
 *     autoincrement ids — a device hanging off a FIOM port must keep its parent.
 *   - the pull is best-effort on the EDGES: a 404 / "no rings" cloud response is
 *     a SUCCESS that imports nothing (NOT an error), so the auto-sync loop does
 *     not treat an un-provisioned subsystem as a failure.
 *
 * Pattern (mirrors vfd-addressed-sync.test.ts): the @/lib/db-sqlite singleton is
 * mocked to an independent in-memory SQLite recreated from the REAL DDL each
 * test; @/lib/config is mocked so the route's getConfig() is controllable; the
 * REAL route handler runs against a mocked global fetch and a fake Express res.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the app's better-sqlite3 singleton with a throwaway in-memory DB. The
// route under test and this test import `db` from the same mocked module, so
// they share the one instance. FK enforcement is OFF by default in SQLite —
// turn it ON so the ON DELETE CASCADE the route relies on actually fires.
vi.mock('@/lib/db-sqlite', async () => {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return { db }
})

// The route reads remoteUrl / apiPassword / subsystemId from configService.
// Make it controllable per-test.
const mockConfig: { remoteUrl: string | null; apiPassword: string | null; subsystemId: number | string | null } = {
  remoteUrl: 'https://cloud.example',
  apiPassword: 'secret',
  subsystemId: 38,
}
vi.mock('@/lib/config', () => ({
  configService: { getConfig: async () => ({ ...mockConfig }) },
}))

import { db } from '@/lib/db-sqlite'
import { POST as pullNetwork } from '@/app/api/cloud/pull-network/route'

// Minimal Express res double: captures the status code and the JSON body.
function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this },
    json(payload: any) { this.body = payload; return this },
  }
  return res
}

async function runPull() {
  const res = makeRes()
  await pullNetwork({} as any, res)
  return res
}

// Read helpers against the in-memory mirror.
const ringsFor = (sid: number) =>
  (db as any).prepare('SELECT * FROM NetworkRings WHERE SubsystemId = ? ORDER BY Name').all(sid) as any[]
const nodesFor = (ringId: number) =>
  (db as any).prepare('SELECT * FROM NetworkNodes WHERE RingId = ? ORDER BY Position').all(ringId) as any[]
const portsFor = (nodeId: number) =>
  (db as any).prepare('SELECT * FROM NetworkPorts WHERE NodeId = ? ORDER BY PortNumber').all(nodeId) as any[]
const countRows = (table: string) =>
  ((db as any).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

beforeEach(() => {
  // Reset config to the happy-path defaults each test.
  mockConfig.remoteUrl = 'https://cloud.example'
  mockConfig.apiPassword = 'secret'
  mockConfig.subsystemId = 38

  // Mirror the production DDL exactly (lib/db-sqlite.ts). The FK references +
  // ON DELETE CASCADE are load-bearing for the subtree wipe.
  ;(db as any).exec('DROP TABLE IF EXISTS NetworkPorts')
  ;(db as any).exec('DROP TABLE IF EXISTS NetworkNodes')
  ;(db as any).exec('DROP TABLE IF EXISTS NetworkRings')
  ;(db as any).exec(`CREATE TABLE NetworkRings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    SubsystemId INTEGER NOT NULL,
    Name TEXT NOT NULL,
    McmName TEXT NOT NULL,
    McmIp TEXT,
    McmTag TEXT,
    CreatedAt TEXT DEFAULT (datetime('now'))
  )`)
  ;(db as any).exec(`CREATE TABLE NetworkNodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    RingId INTEGER NOT NULL REFERENCES NetworkRings(id) ON DELETE CASCADE,
    Name TEXT NOT NULL,
    Position INTEGER NOT NULL,
    IpAddress TEXT,
    CableIn TEXT,
    CableOut TEXT,
    StatusTag TEXT,
    TotalPorts INTEGER DEFAULT 28,
    CreatedAt TEXT DEFAULT (datetime('now'))
  )`)
  ;(db as any).exec(`CREATE TABLE NetworkPorts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    NodeId INTEGER NOT NULL REFERENCES NetworkNodes(id) ON DELETE CASCADE,
    PortNumber TEXT NOT NULL,
    CableLabel TEXT,
    DeviceName TEXT,
    DeviceType TEXT,
    DeviceIp TEXT,
    StatusTag TEXT,
    ParentPortId INTEGER REFERENCES NetworkPorts(id) ON DELETE CASCADE,
    CreatedAt TEXT DEFAULT (datetime('now'))
  )`)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// A realistic cloud /api/network payload: one ring, two nodes; node 1 has a
// FIOM port (cloud id 100) with a sub-device hanging off it (cloud id 101,
// parentPortId 100). Cloud ids are deliberately HIGH so a test would catch the
// route storing them verbatim instead of remapping to local autoincrement ids.
function cloudPayload() {
  return {
    success: true,
    rings: [
      {
        name: 'Ring A',
        mcmName: 'MCM01',
        mcmIp: '11.200.1.2',
        mcmTag: 'MCM01_Tag',
        nodes: [
          {
            name: 'FIOM1', position: 1, ipAddress: '11.200.1.10', statusTag: 'FIOM1:I.Faulted', totalPorts: 28,
            ports: [
              { id: 100, portNumber: '1', deviceName: 'PDP01_FIOM1', deviceType: 'FIOM', deviceIp: '11.200.1.10', statusTag: 'PDP01:I.Faulted' },
              { id: 101, portNumber: '1.1', deviceName: 'UL29_8_DPM1', deviceType: 'DPM', deviceIp: '11.200.1.11', statusTag: null, parentPortId: 100 },
            ],
          },
          {
            name: 'VFD1', position: 2, ipAddress: '11.200.1.20', statusTag: null, totalPorts: 28,
            ports: [
              { id: 200, portNumber: '1', deviceName: 'UL27_10_VFD', deviceType: 'VFD', deviceIp: '11.200.1.20', statusTag: 'UL27_10_VFD:I.ConnectionFaulted' },
            ],
          },
        ],
      },
    ],
  }
}

function stubFetchOk(payload: any, capture?: (url: string, init: any) => void) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    capture?.(url, init)
    return { ok: true, status: 200, json: async () => payload }
  }))
}

describe('POST /api/cloud/pull-network — cloud→field topology pull', () => {
  it('imports rings/nodes/ports and reports the counts', async () => {
    let seenUrl = ''
    let seenInit: any
    stubFetchOk(cloudPayload(), (u, i) => { seenUrl = u; seenInit = i })

    const res = await runPull()

    // Targets the configured cloud + subsystem and sends the API key.
    expect(seenUrl).toBe('https://cloud.example/api/network?subsystemId=38')
    expect(seenInit.headers['X-API-Key']).toBe('secret')

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ success: true, rings: 1, nodes: 2, devices: 3 })

    const rings = ringsFor(38)
    expect(rings).toHaveLength(1)
    expect(rings[0]).toMatchObject({ Name: 'Ring A', McmName: 'MCM01', McmIp: '11.200.1.2', McmTag: 'MCM01_Tag' })

    const nodes = nodesFor(rings[0].id)
    expect(nodes.map(n => n.Name)).toEqual(['FIOM1', 'VFD1'])
    expect(nodes[0]).toMatchObject({ Position: 1, IpAddress: '11.200.1.10', StatusTag: 'FIOM1:I.Faulted', TotalPorts: 28 })

    const fiomPorts = portsFor(nodes[0].id)
    expect(fiomPorts.map(p => p.DeviceName)).toEqual(['PDP01_FIOM1', 'UL29_8_DPM1'])
  })

  it('remaps parent/child sub-port links from CLOUD ids to LOCAL autoincrement ids', async () => {
    stubFetchOk(cloudPayload())
    await runPull()

    const ring = ringsFor(38)[0]
    const fiomNode = nodesFor(ring.id)[0]
    const ports = portsFor(fiomNode.id)
    const parent = ports.find(p => p.DeviceName === 'PDP01_FIOM1')!
    const child = ports.find(p => p.DeviceName === 'UL29_8_DPM1')!

    // The child's ParentPortId points at the LOCAL parent row, not the cloud
    // id 100 (which almost certainly isn't a valid local rowid).
    expect(child.ParentPortId).toBe(parent.id)
    expect(child.ParentPortId).not.toBe(100)
    // The root device has no parent.
    expect(parent.ParentPortId).toBeNull()
  })

  it('is CLOUD-AUTHORITATIVE: a re-pull REPLACES the subsystem (no stale rings linger)', async () => {
    stubFetchOk(cloudPayload())
    await runPull()
    expect(ringsFor(38)).toHaveLength(1)

    // Cloud now reports a different, smaller topology (Ring A renamed/replaced).
    stubFetchOk({
      success: true,
      rings: [{ name: 'Ring B', mcmName: 'MCM01', nodes: [{ name: 'N1', position: 1, ports: [] }] }],
    })
    const res = await runPull()

    const rings = ringsFor(38)
    expect(rings).toHaveLength(1)
    expect(rings[0].Name).toBe('Ring B')        // old "Ring A" gone, not stacked
    expect(res.body).toMatchObject({ rings: 1, nodes: 1, devices: 0 })
  })

  it('the per-subsystem DELETE cascades to nodes AND ports (no orphans survive a re-pull)', async () => {
    stubFetchOk(cloudPayload())
    await runPull()
    expect(countRows('NetworkNodes')).toBe(2)
    expect(countRows('NetworkPorts')).toBe(3)

    // Re-pull a topology with ZERO ports/devices. If the cascade weren't wired,
    // the old NetworkPorts/Nodes rows would be orphaned and linger.
    stubFetchOk({
      success: true,
      rings: [{ name: 'Ring A', mcmName: 'MCM01', nodes: [{ name: 'Empty', position: 1, ports: [] }] }],
    })
    await runPull()

    expect(countRows('NetworkRings')).toBe(1)
    expect(countRows('NetworkNodes')).toBe(1)
    expect(countRows('NetworkPorts')).toBe(0) // cascade removed the 3 old ports
  })

  it('replaces ONLY the target subsystem (no cross-MCM topology wipe)', async () => {
    // Seed subsystem 39 directly — it represents another MCM already pulled.
    const r39 = (db as any).prepare('INSERT INTO NetworkRings (SubsystemId, Name, McmName) VALUES (39, ?, ?)').run('Ring 39', 'MCM02')
    ;(db as any).prepare('INSERT INTO NetworkNodes (RingId, Name, Position) VALUES (?, ?, 1)').run(r39.lastInsertRowid, 'N39')

    mockConfig.subsystemId = 38
    stubFetchOk(cloudPayload())
    await runPull()

    // 38 imported, 39 untouched.
    expect(ringsFor(38)).toHaveLength(1)
    expect(ringsFor(39).map(r => r.Name)).toEqual(['Ring 39'])
    expect(countRows('NetworkRings')).toBe(2)
  })

  it('coerces a string subsystemId from config to a number for the URL + write', async () => {
    mockConfig.subsystemId = '38'
    let seenUrl = ''
    stubFetchOk(cloudPayload(), (u) => { seenUrl = u })
    await runPull()
    expect(seenUrl).toBe('https://cloud.example/api/network?subsystemId=38')
    // Written under the numeric subsystem id, so the numeric reader finds it.
    expect(ringsFor(38)).toHaveLength(1)
  })
})

describe('POST /api/cloud/pull-network — best-effort edges', () => {
  it('treats a cloud 404 as SUCCESS-with-nothing (un-provisioned subsystem is not an error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    const res = await runPull()
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ success: true, rings: 0 })
  })

  it('treats an empty {success:true, rings:[]} cloud response as SUCCESS-with-nothing', async () => {
    stubFetchOk({ success: true, rings: [] })
    const res = await runPull()
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ success: true, rings: 0 })
    expect(countRows('NetworkRings')).toBe(0)
  })

  it('returns 502 on a non-404 HTTP error and does NOT wipe the local mirror', async () => {
    stubFetchOk(cloudPayload())
    await runPull()
    expect(ringsFor(38)).toHaveLength(1)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const res = await runPull()
    expect(res.statusCode).toBe(502)
    // The DELETE only runs AFTER a good payload — a 5xx must leave the mirror intact.
    expect(ringsFor(38)).toHaveLength(1)
  })

  it('returns 400 and does NOT fetch when remoteUrl is missing', async () => {
    mockConfig.remoteUrl = null
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await runPull()
    expect(res.statusCode).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 400 and does NOT fetch when subsystemId is not configured', async () => {
    mockConfig.subsystemId = null
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await runPull()
    expect(res.statusCode).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 500 (not a throw) when fetch rejects, leaving the mirror intact', async () => {
    stubFetchOk(cloudPayload())
    await runPull()
    expect(ringsFor(38)).toHaveLength(1)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const res = await runPull()
    expect(res.statusCode).toBe(500)
    expect(res.body).toMatchObject({ success: false })
    expect(ringsFor(38)).toHaveLength(1)
  })
})
