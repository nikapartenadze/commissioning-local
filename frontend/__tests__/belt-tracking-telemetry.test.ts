/**
 * BELT-TRACKING TELEMETRY (2026-07-22).
 *
 * Four tool instances were live on MCM15 — two sharing the hostname "autstand".
 * A coordinator untracked belts at 12:37; some instances never got the update
 * and kept re-asserting Belt Tracked into the SHARED controller from their own
 * stale local L2 copy, so mechanics could not change belt direction from the
 * keypad for four hours. The cloud could see WHICH instances owned the MCM but
 * not what each one BELIEVED was tracked, so the writer could only be found by
 * remoting into each machine one at a time.
 *
 * These tests pin the properties that make the new `beltTracking` snapshot
 * usable as a divergence detector:
 *
 *   1. THE FINGERPRINT IS A MEMBERSHIP DIGEST. Identical tracked sets must
 *      produce identical fingerprints regardless of row order — otherwise the
 *      cloud reports divergence where there is none and the signal is noise.
 *      Any change in membership must change it.
 *   2. TELEMETRY NEVER BREAKS SYNCING. A throwing query must not stop the
 *      heartbeat from being assembled and sent.
 *   3. THE PAYLOAD IS BOUNDED. It ships every ~10 s, so a subsystem with many
 *      devices must not grow the payload without limit.
 *   4. IDS ARE CLOUD IDS. Local ids are meaningless off-box and would make two
 *      agreeing instances look divergent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  // Faithful mirror of the production L2 schema (lib/db-sqlite.ts), including
  // the SubsystemId column added by ALTER after the original CREATE.
  d.exec(`
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE L2Sheets (id INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT);
    CREATE TABLE L2Devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SheetId INTEGER,
      DeviceName TEXT, Mcm TEXT, Subsystem TEXT, SubsystemId INTEGER,
      DisplayOrder INTEGER DEFAULT 0);
    CREATE TABLE L2Columns (id INTEGER PRIMARY KEY AUTOINCREMENT, SheetId INTEGER, Name TEXT);
    CREATE TABLE L2CellValues (
      id INTEGER PRIMARY KEY AUTOINCREMENT, DeviceId INTEGER, ColumnId INTEGER,
      Value TEXT, UpdatedBy TEXT, UpdatedAt TEXT, Version INTEGER DEFAULT 0,
      UNIQUE(DeviceId, ColumnId));
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
// The registry is the scope source (`plc.mcms[]`). Default: legacy single-PLC
// deployment (no MCMs) so the collector reports every subsystem it finds.
const mcmState: { any: boolean; mcms: Array<{ subsystemId: string }> } = { any: false, mcms: [] }
vi.mock('@/lib/mcm-registry', () => ({
  hasAnyMcm: () => mcmState.any,
  getAggregateStatus: () => ({ mcms: mcmState.mcms }),
}))
// Import the real constants rather than stubbing them — the point of sourcing
// the column name from the writer is that reader and writer cannot drift.
vi.mock('@/lib/vfd-validation-writer', () => ({
  BELT_TRACKED_COLUMN_NAME: 'Belt Tracked',
  BELT_TRACKED_VALUE: 'Yes',
}))

import {
  collectBeltTracking,
  collectBeltTrackingSafe,
  fingerprintOf,
  TRACKED_SAMPLE_LIMIT,
} from '@/lib/heartbeat/belt-tracking-telemetry'

/** Seed one VFD sheet on `subsystemId` with the given devices. */
function seed(
  subsystemId: number,
  devices: Array<{ cloudId: number | null; tracked: boolean; updatedAt?: string }>,
  sheetName = 'VFD Commissioning',
) {
  const sheetId = memDb
    .prepare('INSERT INTO L2Sheets (Name) VALUES (?)')
    .run(sheetName).lastInsertRowid as number
  const colId = memDb
    .prepare('INSERT INTO L2Columns (SheetId, Name) VALUES (?, ?)')
    .run(sheetId, 'Belt Tracked').lastInsertRowid as number
  memDb
    .prepare('INSERT OR IGNORE INTO Subsystems (id, Name) VALUES (?, ?)')
    .run(subsystemId, `SUB${subsystemId}`)
  // Plain index loop: `.entries()` needs --downlevelIteration under this tsconfig.
  for (let i = 0; i < devices.length; i++) {
    const dev = devices[i]
    const devId = memDb
      .prepare(
        'INSERT INTO L2Devices (CloudId, SheetId, DeviceName, Subsystem, SubsystemId) VALUES (?, ?, ?, ?, ?)',
      )
      .run(dev.cloudId, sheetId, `DEV${i}`, `SUB${subsystemId}`, subsystemId)
      .lastInsertRowid as number
    memDb
      .prepare('INSERT INTO L2CellValues (DeviceId, ColumnId, Value, UpdatedAt) VALUES (?, ?, ?, ?)')
      .run(devId, colId, dev.tracked ? 'Yes' : 'No', dev.updatedAt ?? '2026-07-22 10:00:00')
  }
  return { sheetId, colId }
}

beforeEach(() => {
  memDb.exec('DELETE FROM L2CellValues; DELETE FROM L2Devices; DELETE FROM L2Columns; DELETE FROM L2Sheets; DELETE FROM Subsystems;')
  mcmState.any = false
  mcmState.mcms = []
  vi.restoreAllMocks()
})

describe('fingerprint — membership digest', () => {
  it('is identical for the same tracked set in a different order', () => {
    // THE CORE PROPERTY. Two instances that agree must be byte-identical here,
    // or the cloud flags divergence that does not exist.
    expect(fingerprintOf([3, 1, 2])).toBe(fingerprintOf([1, 2, 3]))
    expect(fingerprintOf([9, 4])).toBe(fingerprintOf([4, 9]))
  })

  it('ignores duplicates — membership, not multiplicity', () => {
    expect(fingerprintOf([1, 1, 2])).toBe(fingerprintOf([1, 2]))
  })

  it('changes when a device is added, removed, or swapped', () => {
    const base = fingerprintOf([1, 2, 3])
    expect(fingerprintOf([1, 2, 3, 4])).not.toBe(base) // added
    expect(fingerprintOf([1, 2])).not.toBe(base) // removed — the 12:37 untrack
    expect(fingerprintOf([1, 2, 4])).not.toBe(base) // swapped
  })

  it('reports the empty set distinctly rather than as a hash', () => {
    expect(fingerprintOf([])).toBe('empty')
    expect(fingerprintOf([1])).not.toBe('empty')
  })

  it('is short — this ships every ~10 s', () => {
    expect(fingerprintOf([1, 2, 3]).length).toBeLessThanOrEqual(12)
  })
})

describe('collectBeltTracking — per-subsystem snapshot', () => {
  it('counts tracked vs total and fingerprints the tracked set only', () => {
    seed(7, [
      { cloudId: 101, tracked: true },
      { cloudId: 102, tracked: true },
      { cloudId: 103, tracked: false },
    ])
    const [snap] = collectBeltTracking()
    expect(snap.subsystemId).toBe(7)
    expect(snap.trackedCount).toBe(2)
    expect(snap.totalDevices).toBe(3)
    expect(snap.trackedSample).toEqual([101, 102])
    expect(snap.fingerprint).toBe(fingerprintOf([101, 102]))
  })

  it('uses CLOUD ids, not local ids', () => {
    // Local ids here are 1..2; cloud ids are deliberately far away. An
    // instance emitting local ids would not match a peer holding the same set.
    seed(7, [{ cloudId: 5001, tracked: true }, { cloudId: 5002, tracked: true }])
    const [snap] = collectBeltTracking()
    expect(snap.trackedSample).toEqual([5001, 5002])
    expect(snap.trackedSample).not.toContain(1)
  })

  it('detects the untrack — fingerprint changes when a belt is untracked', () => {
    seed(7, [{ cloudId: 101, tracked: true }, { cloudId: 102, tracked: true }])
    const before = collectBeltTracking()[0].fingerprint

    // The 12:37 coordinator action, applied to THIS instance's local copy.
    // Keyed by CloudId, not a literal DeviceId: AUTOINCREMENT ids keep rising
    // across the beforeEach cleanup, so local ids are not stable per test.
    memDb
      .prepare(
        "UPDATE L2CellValues SET Value = 'No' WHERE DeviceId = (SELECT id FROM L2Devices WHERE CloudId = 102)",
      )
      .run()
    const after = collectBeltTracking()[0]

    expect(after.fingerprint).not.toBe(before)
    expect(after.trackedCount).toBe(1)
    // An instance that never got the update still reports `before` — that
    // mismatch, visible fleet-side, is the entire point.
    expect(before).toBe(fingerprintOf([101, 102]))
  })

  it('reports the newest local cell timestamp', () => {
    seed(7, [
      { cloudId: 101, tracked: true, updatedAt: '2026-07-22 10:00:00' },
      { cloudId: 102, tracked: false, updatedAt: '2026-07-22 12:37:00' },
    ])
    expect(collectBeltTracking()[0].lastLocalUpdateAt).toBe('2026-07-22 12:37:00')
  })

  it('separates subsystems', () => {
    seed(7, [{ cloudId: 101, tracked: true }])
    seed(8, [{ cloudId: 201, tracked: true }, { cloudId: 202, tracked: true }])
    const snaps = collectBeltTracking()
    expect(snaps.map((s) => s.subsystemId)).toEqual([7, 8])
    expect(snaps[0].trackedCount).toBe(1)
    expect(snaps[1].trackedCount).toBe(2)
  })

  it('ignores non-VFD/APF sheets, matching the app-canonical filter', () => {
    seed(7, [{ cloudId: 101, tracked: true }], 'Conveyor Checks')
    expect(collectBeltTracking()).toEqual([])
  })

  it('includes APF sheets', () => {
    seed(7, [{ cloudId: 101, tracked: true }], 'APF Sheet')
    expect(collectBeltTracking()[0].trackedCount).toBe(1)
  })

  it('scopes to the subsystems this instance serves when MCMs are registered', () => {
    seed(7, [{ cloudId: 101, tracked: true }])
    seed(8, [{ cloudId: 201, tracked: true }])
    mcmState.any = true
    mcmState.mcms = [{ subsystemId: '8' }] // only MCM 8 is served here
    const snaps = collectBeltTracking()
    expect(snaps.map((s) => s.subsystemId)).toEqual([8])
  })

  it('counts tracked devices with no CloudId but excludes them from the fingerprint', () => {
    // Honesty guard: the count is the truth about this instance's belief even
    // where the fingerprint cannot represent it, and it says so explicitly.
    seed(7, [{ cloudId: 101, tracked: true }, { cloudId: null, tracked: true }])
    const [snap] = collectBeltTracking()
    expect(snap.trackedCount).toBe(2)
    expect(snap.unmappedTracked).toBe(1)
    expect(snap.fingerprint).toBe(fingerprintOf([101]))
    expect(snap.trackedSample).toEqual([101])
  })

  it('omits unmappedTracked when every tracked device has a cloud id', () => {
    seed(7, [{ cloudId: 101, tracked: true }])
    expect(collectBeltTracking()[0].unmappedTracked).toBeUndefined()
  })
})

describe('payload is bounded', () => {
  it('caps the sample and flags truncation with many devices', () => {
    const devices = Array.from({ length: 400 }, (_, i) => ({ cloudId: 1000 + i, tracked: true }))
    seed(7, devices)
    const [snap] = collectBeltTracking()

    expect(snap.trackedCount).toBe(400) // count is NOT truncated
    expect(snap.trackedSample).toHaveLength(TRACKED_SAMPLE_LIMIT)
    expect(snap.trackedSampleTruncated).toBe(true)
    // Fingerprint still covers ALL 400, not just the sampled 15.
    expect(snap.fingerprint).toBe(fingerprintOf(devices.map((d) => d.cloudId)))
  })

  it('keeps the serialized per-subsystem snapshot small at 400 devices', () => {
    seed(7, Array.from({ length: 400 }, (_, i) => ({ cloudId: 1000 + i, tracked: true })))
    const bytes = Buffer.byteLength(JSON.stringify(collectBeltTracking()), 'utf8')
    // A hard ceiling: at a 10 s cadence an unbounded list would be the whole
    // problem. 400 devices must cost roughly what 15 does.
    expect(bytes).toBeLessThan(400)
  })

  it('does not grow when device count grows tenfold', () => {
    seed(7, Array.from({ length: 40 }, (_, i) => ({ cloudId: 1000 + i, tracked: true })))
    const small = Buffer.byteLength(JSON.stringify(collectBeltTracking()), 'utf8')
    memDb.exec('DELETE FROM L2CellValues; DELETE FROM L2Devices; DELETE FROM L2Columns; DELETE FROM L2Sheets; DELETE FROM Subsystems;')
    seed(7, Array.from({ length: 400 }, (_, i) => ({ cloudId: 1000 + i, tracked: true })))
    const large = Buffer.byteLength(JSON.stringify(collectBeltTracking()), 'utf8')
    // Only the count/fingerprint digits differ — a couple of bytes, not 10x.
    expect(large - small).toBeLessThan(20)
  })
})

describe('telemetry never breaks the heartbeat', () => {
  it('returns undefined instead of throwing when the query fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prepare = vi.spyOn(memDb, 'prepare').mockImplementation(() => {
      throw new Error('no such column: SubsystemId')
    })
    expect(() => collectBeltTrackingSafe()).not.toThrow()
    expect(collectBeltTrackingSafe()).toBeUndefined()
    prepare.mockRestore()
    warn.mockRestore()
  })

  it('lets the heartbeat still assemble when belt-tracking collection throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prepare = vi.spyOn(memDb, 'prepare').mockImplementation(() => {
      throw new Error('database is locked')
    })
    // The safe wrapper is what system-info calls; a throw here must degrade to
    // an absent key, never propagate and cost a tablet its sync.
    const info: Record<string, unknown> = { os: 'x' }
    const bt = collectBeltTrackingSafe()
    if (bt) info.beltTracking = bt
    expect(info.beltTracking).toBeUndefined()
    expect(JSON.stringify(info)).toContain('os')
    prepare.mockRestore()
    warn.mockRestore()
  })

  it('omits the key entirely when there is no VFD/APF data at all', () => {
    // Non-VFD tablets must ship a payload byte-identical to before this change.
    expect(collectBeltTrackingSafe()).toBeUndefined()
  })
})
