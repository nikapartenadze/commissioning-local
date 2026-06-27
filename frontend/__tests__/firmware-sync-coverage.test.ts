/**
 * Cloud→field FIRMWARE-BASELINE sync coverage.
 *
 * The cloud is the source of truth for which firmware revisions are approved
 * per device model. The field tool PULLS that list (GET /api/firmware/approved,
 * header X-API-Key) and caches it in the local ApprovedFirmware table so that
 * firmware compliance evaluates OFFLINE against the last-synced baseline.
 *
 * The pure compliance math (compareRevision / findBaseline / evaluateCompliance)
 * is already covered in firmware-compliance.test.ts. This file pins the SYNC
 * path that feeds it — untested before — exercising the REAL repo functions
 * (syncFirmwareBaseline / getCachedBaselines / getLastBaselineSyncAt) against an
 * in-memory SQLite (the @/lib/db-sqlite singleton, mocked) through a mocked
 * fetch + a mocked config-service singleton.
 *
 * Risks worth pinning so a regression reds CI (incident-shaped — the MCM08/MCM11
 * class is "a cloud error wipes good local state"):
 *   - the cache is replaced WHOLESALE inside ONE transaction (no half-write on a
 *     bad row, no leftover stale entries from a prior, larger pull).
 *   - the pull is BEST-EFFORT: a misconfig / HTTP error / unreachable cloud /
 *     malformed body must NOT touch the cache and must NOT advance lastSyncAt —
 *     the field tool keeps evaluating against whatever it last synced.
 *   - rows are validated/coerced before any write: a row missing a finite
 *     vendorId/productCode/minRev is dropped, not inserted as a NaN/NULL.
 *   - both the bare-array and {items:[...]} envelope shapes are accepted.
 *
 * field→cloud direction: the controller's own firmware IS reported up — folded
 * into the 60s network-diagnostics push as a ControllerPushSnapshot by
 * getControllerPushSnapshots() (lib/plc/identity/firmware-service.ts), consumed
 * in lib/cloud/auto-sync.ts. That builder is driven entirely by live PLC
 * singletons / the MCM registry and an @raw CIP Identity read (hardware), with
 * no DB or fetch surface — it is not unit-testable with this in-memory-DB +
 * mocked-fetch pattern and is exercised by the battle rig instead. There is no
 * field→cloud path that writes the ApprovedFirmware baseline (that table is
 * cloud-authoritative, pull-only), so there is nothing of that shape to assert
 * here. See the closing note in the task summary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the app's better-sqlite3 singleton with a throwaway in-memory DB. Both
// the repo under test and this test import `db` from the same mocked module, so
// they share the one instance.
vi.mock('@/lib/db-sqlite', async () => {
  const Database = (await import('better-sqlite3')).default
  return { db: new Database(':memory:') }
})

// Mock the config-service singleton so syncFirmwareBaseline reads our cfg. The
// real one watches a config.json on disk; we only need getConfig().
const mockConfig: { remoteUrl: string | null; apiPassword: string | null } = {
  remoteUrl: 'https://cloud.example/',
  apiPassword: 'secret',
}
vi.mock('@/lib/config/config-service', () => ({
  configService: {
    getConfig: vi.fn(async () => mockConfig),
  },
}))

import { db } from '@/lib/db-sqlite'
import {
  syncFirmwareBaseline,
  getCachedBaselines,
  getLastBaselineSyncAt,
} from '@/lib/cloud/firmware-baseline-sync'

beforeEach(() => {
  // Mirror the production DDL exactly (lib/db-sqlite.ts ~line 704) — UNIQUE
  // (VendorId, ProductCode) is the baseline key; the sync replaces wholesale.
  ;(db as any).exec('DROP TABLE IF EXISTS ApprovedFirmware')
  ;(db as any).exec(`CREATE TABLE ApprovedFirmware (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    VendorId INTEGER NOT NULL,
    ProductCode INTEGER NOT NULL,
    ModelName TEXT,
    MinRevMajor INTEGER NOT NULL,
    MinRevMinor INTEGER NOT NULL,
    Notes TEXT,
    UpdatedBy TEXT,
    UpdatedAt TEXT,
    UNIQUE(VendorId, ProductCode)
  )`)
  // Reset config to the happy default for each test.
  mockConfig.remoteUrl = 'https://cloud.example/'
  mockConfig.apiPassword = 'secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const okRow = (vendorId: number, productCode: number, minRevMajor: number, minRevMinor: number, extra?: object) => ({
  vendorId, productCode, minRevMajor, minRevMinor, ...extra,
})

describe('syncFirmwareBaseline — cloud→field baseline pull + cache', () => {
  it('sends X-API-Key, strips the trailing slash, caches rows, and round-trips via getCachedBaselines', async () => {
    const fetchSpy = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('https://cloud.example/api/firmware/approved')
      expect(init.method).toBe('GET')
      expect(init.headers['X-API-Key']).toBe('secret')
      return {
        ok: true,
        json: async () => [
          okRow(1, 166, 33, 11, { modelName: '1756-L85E', notes: 'n', updatedBy: 'eng', updatedAt: 't' }),
          okRow(1, 200, 5, 1, { modelName: '1756-EN4TR' }),
        ],
      }
    })
    vi.stubGlobal('fetch', fetchSpy)

    const res = await syncFirmwareBaseline()
    expect(res).toEqual({ ok: true, count: 2 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const cached = getCachedBaselines()
    expect(cached).toHaveLength(2)
    expect(cached.find((b) => b.productCode === 166)).toMatchObject({
      vendorId: 1, productCode: 166, modelName: '1756-L85E', minRevMajor: 33, minRevMinor: 11,
    })
    // ModelName absent on the wire → undefined (not the string "null").
    expect(cached.find((b) => b.productCode === 200)!.modelName).toBe('1756-EN4TR')
  })

  it('advances getLastBaselineSyncAt only on success', async () => {
    const before = getLastBaselineSyncAt()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [okRow(1, 166, 33, 11)] })))
    const t0 = Date.now()
    const res = await syncFirmwareBaseline()
    expect(res.ok).toBe(true)
    const after = getLastBaselineSyncAt()
    expect(after).not.toBe(before)
    expect(after!).toBeGreaterThanOrEqual(t0)
  })

  it('accepts the {items:[...]} envelope as well as a bare array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [okRow(1, 166, 33, 11), okRow(1, 200, 5, 1)] }),
    })))
    const res = await syncFirmwareBaseline()
    expect(res).toEqual({ ok: true, count: 2 })
    expect(getCachedBaselines().map((b) => b.productCode).sort((a, b) => a - b)).toEqual([166, 200])
  })

  it('replaces the cache WHOLESALE — a smaller pull drops entries from the prior, larger pull (no stale leftovers)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => [okRow(1, 166, 33, 11), okRow(1, 200, 5, 1), okRow(1, 300, 2, 0)],
    })))
    expect((await syncFirmwareBaseline()).count).toBe(3)
    expect(getCachedBaselines()).toHaveLength(3)

    // Cloud now approves only one model.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [okRow(1, 166, 34, 0)] })))
    expect((await syncFirmwareBaseline()).count).toBe(1)
    const cached = getCachedBaselines()
    expect(cached).toHaveLength(1)
    expect(cached[0]).toMatchObject({ productCode: 166, minRevMajor: 34, minRevMinor: 0 })
  })

  it('drops rows missing a finite vendorId/productCode/minRev (never half-writes a NaN row)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [
        okRow(1, 166, 33, 11),                       // good
        { productCode: 200, minRevMajor: 5, minRevMinor: 1 }, // no vendorId → dropped
        { vendorId: 1, minRevMajor: 5, minRevMinor: 1 },      // no productCode → dropped
        { vendorId: 1, productCode: 300, minRevMinor: 0 },    // no minRevMajor → dropped
        null,                                        // junk → dropped
      ],
    })))
    const res = await syncFirmwareBaseline()
    expect(res).toEqual({ ok: true, count: 1 })
    expect(getCachedBaselines()).toEqual([
      { vendorId: 1, productCode: 166, modelName: undefined, minRevMajor: 33, minRevMinor: 11 },
    ])
  })

  it('truncates non-integer numerics before caching', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => [okRow(1.9, 166.4, 33.7, 11.2)],
    })))
    expect((await syncFirmwareBaseline()).count).toBe(1)
    expect(getCachedBaselines()[0]).toMatchObject({
      vendorId: 1, productCode: 166, minRevMajor: 33, minRevMinor: 11,
    })
  })

  it('an empty cloud list clears the cache (count 0, ok true)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [okRow(1, 166, 33, 11)] })))
    await syncFirmwareBaseline()
    expect(getCachedBaselines()).toHaveLength(1)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })))
    expect((await syncFirmwareBaseline())).toEqual({ ok: true, count: 0 })
    expect(getCachedBaselines()).toHaveLength(0)
  })
})

describe('syncFirmwareBaseline — best-effort: a failure NEVER wipes the cache', () => {
  // Seed a known-good cache before each failure case via a successful pull.
  const seed = async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [okRow(1, 166, 33, 11)] })))
    await syncFirmwareBaseline()
    expect(getCachedBaselines()).toHaveLength(1)
  }

  it('returns a misconfig error and does NOT fetch when remoteUrl is missing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    mockConfig.remoteUrl = ''
    expect(await syncFirmwareBaseline()).toEqual({ ok: false, error: 'Cloud URL not configured' })
    mockConfig.remoteUrl = null
    expect(await syncFirmwareBaseline()).toEqual({ ok: false, error: 'Cloud URL not configured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns a misconfig error and does NOT fetch when apiPassword is missing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    mockConfig.apiPassword = ''
    expect(await syncFirmwareBaseline()).toEqual({ ok: false, error: 'API key not configured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns the HTTP status as an error and leaves the cache + lastSyncAt intact on a non-OK response', async () => {
    await seed()
    const stamp = getLastBaselineSyncAt()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    expect(await syncFirmwareBaseline()).toEqual({ ok: false, error: 'Cloud returned 503' })
    expect(getCachedBaselines()).toHaveLength(1)
    expect(getLastBaselineSyncAt()).toBe(stamp)
  })

  it('never throws and leaves the cache intact when fetch rejects (cloud unreachable)', async () => {
    await seed()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const res = await syncFirmwareBaseline()
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Cloud unreachable')
    expect(res.error).toContain('network down')
    expect(getCachedBaselines()).toHaveLength(1)
  })

  it('returns a malformed-response error and leaves the cache intact when the body is not JSON', async () => {
    await seed()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json') } })))
    expect(await syncFirmwareBaseline()).toEqual({ ok: false, error: 'Malformed baseline response' })
    expect(getCachedBaselines()).toHaveLength(1)
  })
})
