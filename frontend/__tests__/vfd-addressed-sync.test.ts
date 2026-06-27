/**
 * Cloud→field VFD ADDRESSED mirror — pull + cloud-authoritative upsert.
 *
 * ADDRESSED is a CLOUD-ONLY handoff flag: a mechanic marks a BLOCKED belt VFD
 * "physical issue fixed — re-run the wizard" on the cloud app, and the field tool
 * only PULLS it (never pushes). Risks worth pinning so a regression reds CI:
 *
 *   - the upsert is CLOUD-AUTHORITATIVE for the subsystem: a device the cloud no
 *     longer lists must be CLEARED locally, not left stale — else a field tech
 *     sees a re-opened belt as still "addressed". (incident-shaped: stale local
 *     state surviving a cloud change is the MCM08/MCM11 class.)
 *   - it must only touch the TARGET subsystem (no cross-MCM wipe).
 *   - the pull is BEST-EFFORT: returns 0 (never throws into the auto-sync loop) on
 *     misconfig / HTTP error / malformed payload, and a cloud ERROR must NOT wipe
 *     the local mirror — only a successful response replaces it.
 *
 * The repo runs against an independent in-memory SQLite (the @/lib/db-sqlite
 * singleton is mocked to it); the pull runs the REAL repo through a mocked fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the app's better-sqlite3 singleton with a throwaway in-memory DB. Both
// the repository (under test) and this test import `db` from the same mocked
// module, so they share the one instance.
vi.mock('@/lib/db-sqlite', async () => {
  const Database = (await import('better-sqlite3')).default
  return { db: new Database(':memory:') }
})

import { db } from '@/lib/db-sqlite'
import {
  upsertVfdAddressedFromCloud,
  listVfdAddressedStates,
} from '@/lib/db/repositories/vfd-addressed-sync-repository'
import { pullVfdAddressed } from '@/lib/cloud/vfd-addressed-pull'

beforeEach(() => {
  // Mirror the production DDL exactly (lib/db-sqlite.ts) — PK(SubsystemId,
  // DeviceName) is what the upsert's ON CONFLICT resolves on.
  ;(db as any).exec('DROP TABLE IF EXISTS VfdAddressed')
  ;(db as any).exec(`CREATE TABLE VfdAddressed (
    SubsystemId INTEGER NOT NULL,
    DeviceName  TEXT NOT NULL,
    Addressed   INTEGER NOT NULL DEFAULT 0,
    AddressedBy TEXT,
    AddressedAt TEXT,
    PRIMARY KEY (SubsystemId, DeviceName)
  )`)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('upsertVfdAddressedFromCloud — cloud-authoritative mirror', () => {
  it('writes rows and reads them back round-trip', () => {
    const n = upsertVfdAddressedFromCloud(38, [
      { deviceName: 'CBT_UL21_3_VFD', addressed: true, addressedBy: 'mech@x', addressedAt: '2026-06-27T00:00:00Z' },
      { deviceName: 'CBT_UL22_1_VFD', addressed: false },
    ])
    expect(n).toBe(2)
    const states = listVfdAddressedStates()
    expect(states).toHaveLength(2)
    expect(states.find(s => s.deviceName === 'CBT_UL21_3_VFD')).toMatchObject({
      subsystemId: 38, addressed: true, addressedBy: 'mech@x', addressedAt: '2026-06-27T00:00:00Z',
    })
    expect(states.find(s => s.deviceName === 'CBT_UL22_1_VFD')!.addressed).toBe(false)
  })

  it('is CLOUD-AUTHORITATIVE: a device no longer listed is CLEARED, not left stale', () => {
    upsertVfdAddressedFromCloud(38, [
      { deviceName: 'A', addressed: true },
      { deviceName: 'B', addressed: true },
    ])
    // Cloud now reports only A (B's blocker was cleared / un-pressed).
    const n = upsertVfdAddressedFromCloud(38, [{ deviceName: 'A', addressed: true }])
    expect(n).toBe(1)
    expect(listVfdAddressedStates().map(s => s.deviceName)).toEqual(['A'])
  })

  it('replaces ONLY the target subsystem (no cross-MCM wipe)', () => {
    upsertVfdAddressedFromCloud(38, [{ deviceName: 'A', addressed: true }])
    upsertVfdAddressedFromCloud(39, [{ deviceName: 'Z', addressed: true }])
    upsertVfdAddressedFromCloud(38, []) // re-pull 38 empty → clears 38 only
    const states = listVfdAddressedStates()
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ subsystemId: 39, deviceName: 'Z' })
  })

  it('skips blank/whitespace device names and trims the rest', () => {
    const n = upsertVfdAddressedFromCloud(38, [
      { deviceName: '   ', addressed: true },
      { deviceName: '', addressed: true },
      { deviceName: '  CBT_TRIM  ', addressed: true },
    ])
    expect(n).toBe(1)
    expect(listVfdAddressedStates()[0].deviceName).toBe('CBT_TRIM')
  })

  it('nulls addressedBy/addressedAt when addressed is false', () => {
    upsertVfdAddressedFromCloud(38, [
      { deviceName: 'A', addressed: false, addressedBy: 'should-drop', addressedAt: 'should-drop' },
    ])
    const s = listVfdAddressedStates()[0]
    expect(s.addressed).toBe(false)
    expect(s.addressedBy).toBeNull()
    expect(s.addressedAt).toBeNull()
  })
})

describe('pullVfdAddressed — best-effort cloud→field pull', () => {
  const cfg = { remoteUrl: 'https://cloud.example/', apiPassword: 'secret' }

  it('returns 0 and does NOT fetch when subsystemId is invalid', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await pullVfdAddressed(0, cfg)).toBe(0)
    expect(await pullVfdAddressed(-3, cfg)).toBe(0)
    expect(await pullVfdAddressed(1.5, cfg)).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 0 and does NOT fetch when remoteUrl is missing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await pullVfdAddressed(38, { remoteUrl: '', apiPassword: 'x' })).toBe(0)
    expect(await pullVfdAddressed(38, { remoteUrl: null, apiPassword: 'x' })).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends X-API-Key, strips the trailing slash, and mirrors {rows} locally', async () => {
    const fetchSpy = vi.fn(async (url: string, init: any) => {
      expect(url).toBe('https://cloud.example/api/sync/vfd-addressed?subsystemId=38')
      expect(init.headers['X-API-Key']).toBe('secret')
      return { ok: true, json: async () => ({ rows: [
        { deviceName: 'CBT_A', addressed: true, addressedBy: 'm', addressedAt: 't' },
        { deviceName: 'CBT_B', addressed: false },
      ] }) }
    })
    vi.stubGlobal('fetch', fetchSpy)
    expect(await pullVfdAddressed(38, cfg)).toBe(2)
    expect(listVfdAddressedStates().map(s => s.deviceName).sort()).toEqual(['CBT_A', 'CBT_B'])
  })

  it('tolerates a bare array AND an {addressed:[...]} envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ([{ deviceName: 'X', addressed: true }]) })))
    expect(await pullVfdAddressed(38, cfg)).toBe(1)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ addressed: [{ deviceName: 'Y', addressed: true }] }) })))
    expect(await pullVfdAddressed(38, cfg)).toBe(1)
    expect(listVfdAddressedStates()[0].deviceName).toBe('Y') // subsystem replaced
  })

  it('drops rows with a non-string deviceName and coerces addressed to boolean', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ rows: [
      { deviceName: 'GOOD', addressed: 1 }, // truthy → addressed
      { deviceName: 123, addressed: true }, // non-string name → dropped
      { addressed: true },                  // no name → dropped
      null,                                 // junk → dropped
    ] }) })))
    expect(await pullVfdAddressed(38, cfg)).toBe(1)
    const s = listVfdAddressedStates()[0]
    expect(s.deviceName).toBe('GOOD')
    expect(s.addressed).toBe(true)
  })

  it('returns 0 on a non-OK HTTP status and does NOT wipe the local mirror', async () => {
    upsertVfdAddressedFromCloud(38, [{ deviceName: 'KEEP', addressed: true }])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    expect(await pullVfdAddressed(38, cfg)).toBe(0)
    expect(listVfdAddressedStates().map(s => s.deviceName)).toEqual(['KEEP'])
  })

  it('never throws and returns 0 when fetch rejects (best-effort)', async () => {
    upsertVfdAddressedFromCloud(38, [{ deviceName: 'KEEP', addressed: true }])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(pullVfdAddressed(38, cfg)).resolves.toBe(0)
    expect(listVfdAddressedStates().map(s => s.deviceName)).toEqual(['KEEP'])
  })
})
