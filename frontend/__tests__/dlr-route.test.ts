/**
 * Integration tests for GET /api/mcm/:subsystemId/dlr
 * (app/api/mcm/[subsystemId]/dlr/route.ts).
 *
 * No hardware. The reader (readDlrAoiForMcm), the poller snapshots
 * (getMcmNetworkSnapshots), the config service and the SQLite handle are all
 * mocked; the pure decode (dlr-aoi.ts) is left REAL so the verdict the route
 * emits is the genuine decode of the reading, end to end.
 *
 * The hard product requirement under test throughout: this endpoint ALWAYS
 * responds HTTP 200. The Network page calls it, and a 500 would take down a page
 * whose other panels are fine. Every failure is a 200 + `{ ok:false, reason }`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  snapshots: [] as any[],
  snapshotsThrow: null as any,
  mcmName: 'MCM08' as string | null,
  configThrow: null as any,
  dbName: undefined as string | undefined,
  read: null as any,
  readThrow: null as any,
}))

vi.mock('@/lib/mcm-registry', () => ({
  getMcmNetworkSnapshots: vi.fn((_sid: string) => {
    if (state.snapshotsThrow) throw state.snapshotsThrow
    return state.snapshots
  }),
}))

vi.mock('@/lib/config', () => ({
  configService: {
    getMcm: vi.fn(async (_sid: string) => {
      if (state.configThrow) throw state.configThrow
      return state.mcmName === null ? null : { name: state.mcmName }
    }),
  },
}))

vi.mock('@/lib/db-sqlite', () => ({
  db: {
    prepare: () => ({ get: () => (state.dbName ? { Name: state.dbName } : undefined) }),
  },
}))

vi.mock('@/lib/plc/network/dlr-aoi-reader', () => ({
  readDlrAoiForMcm: vi.fn(async (_sid: string, _base: string) => {
    if (state.readThrow) throw state.readThrow
    return state.read
  }),
}))

import { GET } from '@/app/api/mcm/[subsystemId]/dlr/route'
import { decodeDlrAoi } from '@/lib/plc/network/dlr-aoi'

const NODE_A = [192, 168, 5, 10, 0x00, 0x1d, 0x9c, 0x11, 0x22, 0x33]
const NODE_B = [192, 168, 5, 11, 0x00, 0x1d, 0x9c, 0x11, 0x22, 0x34]
const ZEROS = () => new Array(10).fill(0)

/** Express res double that records the status code AND every status() call. */
function fakeRes() {
  const out: any = { statusCode: 200, statusCalls: [] as number[], body: null }
  const res: any = {
    status(c: number) {
      out.statusCode = c
      out.statusCalls.push(c)
      return res
    },
    json(b: any) {
      out.body = b
      return res
    },
  }
  return { res, out }
}

async function call(subsystemId = '47') {
  const { res, out } = fakeRes()
  await GET({ params: { subsystemId } } as any, res)
  return out
}

/** Assert the hard requirement: 200, and no error status was ever set. */
function expect200(out: any) {
  expect(out.statusCode).toBe(200)
  expect(out.statusCalls).not.toContain(500)
  expect(out.statusCalls.some((c: number) => c >= 400)).toBe(false)
}

function reading(over: Partial<any> = {}) {
  return {
    breakPresent: 0,
    communicationFaulted: false,
    point1: ZEROS(),
    point2: ZEROS(),
    ...over,
  }
}

beforeEach(() => {
  state.snapshots = [{ deviceName: 'SLOT2_EN4TR', tagName: 'SLOT2_EN4TR_NetworkNode' }]
  state.snapshotsThrow = null
  state.mcmName = 'MCM08'
  state.configThrow = null
  state.dbName = undefined
  state.read = { ok: true, reading: reading() }
  state.readThrow = null
})

describe('GET /api/mcm/:subsystemId/dlr — happy path', () => {
  it('returns {ok, base, reading, verdict} with the verdict matching decodeDlrAoi', async () => {
    const r = reading({ breakPresent: 1, point1: NODE_A, point2: NODE_B })
    state.read = { ok: true, reading: r }

    const out = await call()

    expect200(out)
    expect(out.body.ok).toBe(true)
    expect(out.body.base).toBe('MCM08_SLOT2_EN4TR')
    expect(out.body.reading).toEqual(r)
    expect(out.body.verdict).toEqual(decodeDlrAoi(r))
    expect(out.body.verdict.breakBetween).toEqual([
      { ip: '192.168.5.10', mac: '00:1d:9c:11:22:33' },
      { ip: '192.168.5.11', mac: '00:1d:9c:11:22:34' },
    ])
  })

  it('falls back to the Subsystems row for the MCM name when config has none', async () => {
    state.mcmName = null
    state.dbName = 'MCM11'
    state.snapshots = [{ deviceName: 'SLOT3_EN2TR' }]

    const out = await call()

    expect200(out)
    expect(out.body.ok).toBe(true)
    expect(out.body.base).toBe('MCM11_SLOT3_EN2TR')
  })
})

describe('GET /api/mcm/:subsystemId/dlr — all four verdict states end to end', () => {
  it('healthy: status 0', async () => {
    state.read = { ok: true, reading: reading({ breakPresent: 0 }) }
    const out = await call()
    expect200(out)
    expect(out.body.ok).toBe(true)
    expect(out.body.verdict.state).toBe('healthy')
    expect(out.body.verdict.statusCode).toBe(0)
    expect(out.body.verdict.statusLabel).toBe('Normal')
  })

  it('broken: status 1 (Ring Fault)', async () => {
    state.read = { ok: true, reading: reading({ breakPresent: 1 }) }
    const out = await call()
    expect200(out)
    expect(out.body.verdict.state).toBe('broken')
    expect(out.body.verdict.reason).toBe('Ring Fault')
  })

  it('comm-fault: Communication_Faulted true', async () => {
    state.read = { ok: true, reading: reading({ communicationFaulted: true, breakPresent: 1 }) }
    const out = await call()
    expect200(out)
    expect(out.body.verdict.state).toBe('comm-fault')
    // A module we cannot talk to tells us nothing about the ring — it must NOT
    // be laundered into 'broken' even though the status byte says Ring Fault.
    expect(out.body.verdict.state).not.toBe('broken')
    expect(out.body.verdict.statusCode).toBeNull()
  })

  it('unknown: breakPresent null (read failed) — never reported as healthy', async () => {
    state.read = { ok: true, reading: reading({ breakPresent: null }) }
    const out = await call()
    expect200(out)
    expect(out.body.verdict.state).toBe('unknown')
    expect(out.body.verdict.state).not.toBe('healthy')
    expect(out.body.reading.breakPresent).toBeNull()
  })

  // ── The two states the PLC's own flag gets WRONG ───────────────────────────
  // AOI_RACK_NETWORK_NODE computes DLR_Broken as a bit-0 test of the status
  // byte. Status 2 and 4 both have bit 0 CLEAR, so the PLC's own flag calls
  // these real ring problems "healthy". Our decode reads the full enumeration
  // and must report them as broken — that is the entire point of the module.
  it('status 2 (Unexpected Loop Detected) comes back BROKEN through the route — the PLC bit-0 flag misses this', async () => {
    state.read = { ok: true, reading: reading({ breakPresent: 2 }) }
    const out = await call()
    expect200(out)
    expect(out.body.verdict.state).toBe('broken')
    expect(out.body.verdict.reason).toBe('Unexpected Loop Detected')
    expect(out.body.verdict.statusCode & 1).toBe(0) // bit 0 clear: PLC would say "fine"
  })

  it('status 4 (Rapid Fault/Restore Cycle) comes back BROKEN through the route — the PLC bit-0 flag misses this', async () => {
    state.read = { ok: true, reading: reading({ breakPresent: 4 }) }
    const out = await call()
    expect200(out)
    expect(out.body.verdict.state).toBe('broken')
    expect(out.body.verdict.reason).toBe('Rapid Fault/Restore Cycle')
    expect(out.body.verdict.statusCode & 1).toBe(0)
  })
})

describe('GET /api/mcm/:subsystemId/dlr — no AOI base resolvable', () => {
  it('returns {ok:false, reason} mentioning the rack Ethernet module when there are no snapshots', async () => {
    state.snapshots = []
    const out = await call()
    expect200(out)
    expect(out.body.ok).toBe(false)
    expect(out.body.reason).toMatch(/rack Ethernet module/i)
    expect(out.body.reason).toMatch(/EN2TR|EN4TR/)
  })

  it('returns {ok:false, reason} when snapshots hold no EN2TR/EN4TR device', async () => {
    state.snapshots = [{ deviceName: 'UL27_10_VFD' }, { deviceName: 'SLOT0_L8' }]
    const out = await call()
    expect200(out)
    expect(out.body.ok).toBe(false)
    expect(out.body.reason).toMatch(/rack Ethernet module/i)
  })

  it('returns {ok:false, reason} when the MCM name cannot be resolved at all', async () => {
    state.mcmName = null
    state.dbName = undefined
    const out = await call()
    expect200(out)
    expect(out.body.ok).toBe(false)
    expect(out.body.reason).toMatch(/rack Ethernet module/i)
  })
})

describe('GET /api/mcm/:subsystemId/dlr — ALWAYS 200, never 500', () => {
  it('reader returns {ok:false} → 200 with the reader\'s reason and the base', async () => {
    state.read = { ok: false, reason: 'MCM 47 is not connected to its PLC — cannot read the DLR AOI tags.' }

    const out = await call()

    expect200(out)
    expect(out.body.ok).toBe(false)
    expect(out.body.base).toBe('MCM08_SLOT2_EN4TR')
    expect(out.body.reason).toMatch(/not connected/i)
  })

  it('reader returns ok:true but no reading → 200 with a fallback reason', async () => {
    state.read = { ok: true }
    const out = await call()
    expect200(out)
    expect(out.body.ok).toBe(false)
    expect(out.body.reason.length).toBeGreaterThan(0)
  })

  it('reader REJECTS → 200, not 500, and the route does not throw', async () => {
    state.readThrow = new Error('libplctag exploded')

    const { res, out } = fakeRes()
    await expect(GET({ params: { subsystemId: '47' } } as any, res)).resolves.not.toThrow()

    expect200(out)
    expect(out.body.ok).toBe(false)
    expect(out.body.reason).toBe('libplctag exploded')
  })

  it('snapshot lookup THROWS → 200, not 500', async () => {
    state.snapshotsThrow = new Error('registry blew up')
    const out = await call()
    expect200(out)
    expect(out.body.ok).toBe(false)
    expect(out.body.reason).toBe('registry blew up')
  })

  it('configService.getMcm throwing does not break the request', async () => {
    state.configThrow = new Error('config file locked')
    state.dbName = 'MCM08'
    const out = await call()
    expect200(out)
    expect(out.body.ok).toBe(true)
    expect(out.body.base).toBe('MCM08_SLOT2_EN4TR')
  })

  it('a non-Error throw still yields 200 with a generic reason', async () => {
    state.readThrow = 'boom'
    const out = await call()
    expect200(out)
    expect(out.body.ok).toBe(false)
    expect(out.body.reason).toBe('Internal error reading DLR status.')
  })
})

describe('GET /api/mcm/:subsystemId/dlr — no fabricated 0.0.0.0 break location', () => {
  /**
   * The PLC zero-fills both Break_Point arrays on every scan while the ring is
   * healthy, so all-zero means "healthy or never populated" — NOT "the break is
   * at node 0.0.0.0". breakBetween must stay null and 0.0.0.0 must never appear
   * anywhere in the response.
   */
  it('breakBetween is null when both break-point arrays are all zeros (healthy status)', async () => {
    state.read = { ok: true, reading: reading({ breakPresent: 0 }) }
    const out = await call()
    expect200(out)
    expect(out.body.verdict.breakBetween).toBeNull()
    expect(JSON.stringify(out.body)).not.toContain('0.0.0.0')
  })

  it('breakBetween is null when both arrays are all zeros even on a BROKEN status', async () => {
    // Ring is genuinely faulted but the PLC has not localized it. Reporting a
    // 0.0.0.0 node here would send a technician to a nonexistent device.
    state.read = { ok: true, reading: reading({ breakPresent: 1 }) }
    const out = await call()
    expect200(out)
    expect(out.body.verdict.state).toBe('broken')
    expect(out.body.verdict.breakBetween).toBeNull()
    expect(JSON.stringify(out.body)).not.toContain('0.0.0.0')
  })

  it('breakBetween is null when the reader dropped both arrays as unreadable', async () => {
    state.read = { ok: true, reading: reading({ breakPresent: 1, point1: [], point2: [] }) }
    const out = await call()
    expect200(out)
    expect(out.body.verdict.breakBetween).toBeNull()
    expect(JSON.stringify(out.body)).not.toContain('0.0.0.0')
  })

  it('never emits 0.0.0.0 when only one side localized', async () => {
    state.read = { ok: true, reading: reading({ breakPresent: 1, point1: NODE_A, point2: ZEROS() }) }
    const out = await call()
    expect200(out)
    expect(out.body.verdict.breakBetween).toEqual([
      { ip: '192.168.5.10', mac: '00:1d:9c:11:22:33' },
      { ip: null, mac: null },
    ])
    expect(JSON.stringify(out.body)).not.toContain('0.0.0.0')
  })
})
