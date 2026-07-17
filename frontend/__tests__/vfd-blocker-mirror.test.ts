/**
 * Cloud→field VFD BLOCKER mirror — pull + cloud-authoritative upsert with an
 * in-flight-local-intent guard.
 *
 * A blocker ("belt slipping — Mechanical") raised on ONE box flows UP to the
 * cloud; this mirror brings it back DOWN to the OTHER boxes so blocked/ready
 * agrees everywhere (the 2026-07-16 MCM15 divergence: cloud 62 ready / 11
 * blocked vs a local box 73 ready / 0 blocked). Risks pinned here:
 *
 *   - CLOUD-AUTHORITATIVE for the subsystem: a device the cloud no longer lists
 *     is UNBLOCKED locally, not left stale (the MCM08/MCM11 stale-state class).
 *   - touches ONLY the target subsystem (no cross-MCM wipe).
 *   - NEVER clobbers in-flight LOCAL intent: a device with an active
 *     DeviceBlockerPendingSyncs row (set OR clear) is skipped, so a just-cleared
 *     blocker can't reappear and a just-raised one can't be pre-empted.
 *   - the pull is BEST-EFFORT: returns 0 (never throws into the auto-sync loop)
 *     on misconfig / HTTP error / malformed payload; a cloud ERROR must NOT wipe
 *     the local mirror.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/lib/db-sqlite', async () => {
  const Database = (await import('better-sqlite3')).default
  return { db: new Database(':memory:') }
})

import { db } from '@/lib/db-sqlite'
import {
  applyVfdBlockersFromCloud,
  listVfdBlockerStates,
} from '@/lib/db/repositories/vfd-blocker-mirror-repository'
import { pullVfdBlockers } from '@/lib/cloud/vfd-blockers-pull'

function enqueuePending(subsystemId: number, deviceName: string, op: 'set' | 'clear' = 'set') {
  db.prepare(
    `INSERT INTO DeviceBlockerPendingSyncs
       (SubsystemId, DeviceName, Op, RetryCount, DeadLettered)
     VALUES (?, ?, ?, 0, 0)`,
  ).run(subsystemId, deviceName, op)
}

beforeEach(() => {
  // Mirror the production DDL exactly (lib/db-sqlite.ts).
  ;(db as any).exec('DROP TABLE IF EXISTS VfdBlocker')
  ;(db as any).exec(`CREATE TABLE VfdBlocker (
    SubsystemId INTEGER NOT NULL,
    DeviceName  TEXT NOT NULL,
    Party       TEXT,
    Description TEXT,
    UpdatedBy   TEXT,
    UpdatedAt   TEXT,
    AddressedBy TEXT,
    AddressedAt TEXT,
    PRIMARY KEY (SubsystemId, DeviceName)
  )`)
  // Minimal DeviceBlockerPendingSyncs (only the columns the guard reads).
  ;(db as any).exec('DROP TABLE IF EXISTS DeviceBlockerPendingSyncs')
  ;(db as any).exec(`CREATE TABLE DeviceBlockerPendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    SubsystemId INTEGER NOT NULL,
    DeviceName TEXT NOT NULL,
    Op TEXT NOT NULL,
    RetryCount INTEGER DEFAULT 0,
    DeadLettered INTEGER NOT NULL DEFAULT 0
  )`)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('applyVfdBlockersFromCloud — cloud-authoritative mirror', () => {
  it('writes rows and reads them back round-trip', () => {
    const n = applyVfdBlockersFromCloud(51, [
      { deviceName: 'BYBA_7_VFD', party: 'Mechanical', description: 'belt is slipping', updatedBy: 'Arick', updatedAt: '2026-07-16T18:29:00Z' },
      { deviceName: 'BYCB_1_VFD', party: 'Mechanical', description: 'belt not moving' },
    ])
    expect(n).toBe(2)
    const states = listVfdBlockerStates()
    expect(states).toHaveLength(2)
    expect(states.find(s => s.deviceName === 'BYBA_7_VFD')).toMatchObject({
      subsystemId: 51, party: 'Mechanical', description: 'belt is slipping', updatedBy: 'Arick',
    })
  })

  it('is CLOUD-AUTHORITATIVE: a device no longer listed is UNBLOCKED, not left stale', () => {
    applyVfdBlockersFromCloud(51, [
      { deviceName: 'A', party: 'Mechanical', description: 'x' },
      { deviceName: 'B', party: 'Mechanical', description: 'y' },
    ])
    // Cloud now reports only A (B's belt was fixed → blocker cleared).
    const n = applyVfdBlockersFromCloud(51, [{ deviceName: 'A', party: 'Mechanical', description: 'x' }])
    expect(n).toBe(1)
    expect(listVfdBlockerStates().map(s => s.deviceName)).toEqual(['A'])
  })

  it('replaces ONLY the target subsystem (no cross-MCM wipe)', () => {
    applyVfdBlockersFromCloud(51, [{ deviceName: 'A', party: 'Mechanical', description: 'x' }])
    applyVfdBlockersFromCloud(52, [{ deviceName: 'Z', party: 'Mechanical', description: 'z' }])
    applyVfdBlockersFromCloud(51, []) // re-pull 51 empty → clears 51 only
    const states = listVfdBlockerStates()
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ subsystemId: 52, deviceName: 'Z' })
  })

  it('skips blank/whitespace device names and trims the rest', () => {
    const n = applyVfdBlockersFromCloud(51, [
      { deviceName: '   ', party: 'Mechanical', description: 'x' },
      { deviceName: '', party: 'Mechanical', description: 'x' },
      { deviceName: '  BYTRIM_VFD  ', party: 'Mechanical', description: 'x' },
    ])
    expect(n).toBe(1)
    expect(listVfdBlockerStates()[0].deviceName).toBe('BYTRIM_VFD')
  })

  describe('in-flight local intent guard (DeviceBlockerPendingSyncs)', () => {
    it('does NOT write a mirror row for a device with a pending local op (case-insensitive)', () => {
      enqueuePending(51, 'BYBA_7_VFD', 'clear') // tech just cleared it locally
      const n = applyVfdBlockersFromCloud(51, [
        { deviceName: 'byba_7_vfd', party: 'Mechanical', description: 'belt is slipping' }, // cloud still blocked
        { deviceName: 'BYCB_1_VFD', party: 'Mechanical', description: 'belt not moving' },
      ])
      // Only the non-pending device is mirrored; the pending one is left to the
      // local Bump Blocker cell so the just-cleared blocker can't reappear.
      expect(n).toBe(1)
      expect(listVfdBlockerStates().map(s => s.deviceName)).toEqual(['BYCB_1_VFD'])
    })

    it('a parked (DeadLettered=1) local op STILL guards the device', () => {
      db.prepare(
        `INSERT INTO DeviceBlockerPendingSyncs (SubsystemId, DeviceName, Op, RetryCount, DeadLettered)
         VALUES (51, 'BYBA_8_VFD', 'set', 5, 1)`,
      ).run()
      const n = applyVfdBlockersFromCloud(51, [
        { deviceName: 'BYBA_8_VFD', party: 'Mechanical', description: 'belt is slipping' },
      ])
      expect(n).toBe(0)
      expect(listVfdBlockerStates()).toHaveLength(0)
    })

    it('a pending op on ANOTHER device does not block unrelated mirroring', () => {
      enqueuePending(51, 'OTHER_VFD', 'set')
      const n = applyVfdBlockersFromCloud(51, [
        { deviceName: 'BYCB_1_VFD', party: 'Mechanical', description: 'belt not moving' },
      ])
      expect(n).toBe(1)
    })
  })
})

describe('pullVfdBlockers — best-effort cloud→field pull', () => {
  const cfg = { remoteUrl: 'https://cloud.example/', apiPassword: 'secret' }

  it('returns 0 and does NOT fetch when subsystemId is invalid', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await pullVfdBlockers(0, cfg)).toBe(0)
    expect(await pullVfdBlockers(-3, cfg)).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 0 when unconfigured (no remoteUrl)', async () => {
    expect(await pullVfdBlockers(51, { remoteUrl: '', apiPassword: 'x' })).toBe(0)
    expect(await pullVfdBlockers(51, { remoteUrl: null, apiPassword: 'x' })).toBe(0)
  })

  it('mirrors the { blockers: [...] } payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, subsystemId: 51, blockers: [
        { deviceName: 'BYBA_7_VFD', party: 'Mechanical', description: 'belt is slipping' },
        { deviceName: 'BYCB_1_VFD', party: 'Mechanical', description: 'belt not moving' },
      ] }),
      { status: 200 },
    )))
    expect(await pullVfdBlockers(51, cfg)).toBe(2)
    expect(listVfdBlockerStates()).toHaveLength(2)
  })

  it('a cloud ERROR does NOT wipe the local mirror', async () => {
    applyVfdBlockersFromCloud(51, [{ deviceName: 'A', party: 'Mechanical', description: 'x' }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect(await pullVfdBlockers(51, cfg)).toBe(0)
    expect(listVfdBlockerStates()).toHaveLength(1) // untouched
  })

  it('returns 0 on a network throw (never rejects into the loop)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    await expect(pullVfdBlockers(51, cfg)).resolves.toBe(0)
  })
})
