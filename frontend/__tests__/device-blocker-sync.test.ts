/**
 * Test: DeviceBlockerPendingSyncs offline queue repository.
 *
 * Covers the behaviors Task 2 promises for the device-level VFD bump-test
 * blocker queue (see frontend/specs/2026-06-04-vfd-bump-blocker-plan.md):
 *   - enqueueDeviceBlockerSet inserts an Op='set' row with the party/description
 *   - enqueueDeviceBlockerClear inserts an Op='clear' row with the expected pair
 *   - listDeviceBlockerSyncs returns rows oldest-first
 *   - deleteDeviceBlockerSync removes a row
 *   - recordDeviceBlockerSyncFailure bumps RetryCount + sets LastError
 *   - recordDeviceBlockerSyncTransientFailure sets LastError WITHOUT a strike
 *
 * The repository imports the shared better-sqlite3 singleton from
 * '@/lib/db-sqlite'; we mock that module with a fresh in-memory DB carrying
 * the verbatim DeviceBlockerPendingSyncs DDL so the test never touches the
 * real database file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Hoisted so vi.mock (also hoisted) can reference it without a TDZ error.
const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE IF NOT EXISTS DeviceBlockerPendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      SubsystemId INTEGER NOT NULL,
      DeviceName TEXT NOT NULL,
      Op TEXT NOT NULL,
      BlockerResponsibleParty TEXT,
      BlockerDescription TEXT,
      ExpectedParty TEXT,
      ExpectedDescription TEXT,
      UpdatedBy TEXT,
      Timestamp TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0,
      LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_deviceblockersyncs_createdat ON DeviceBlockerPendingSyncs(CreatedAt);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))

import {
  enqueueDeviceBlockerSet,
  enqueueDeviceBlockerClear,
  listDeviceBlockerSyncs,
  listParkedDeviceBlockerSyncs,
  deleteDeviceBlockerSync,
  recordDeviceBlockerSyncFailure,
  recordDeviceBlockerSyncTransientFailure,
  parkDeviceBlockerSync,
  unparkDeviceBlockerSync,
  countParkedDeviceBlockerSyncs,
} from '@/lib/db/repositories/device-blocker-sync-repository'

describe('device-blocker-sync-repository', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM DeviceBlockerPendingSyncs')
  })

  it('enqueueDeviceBlockerSet inserts an Op=set row with party + description', () => {
    const id = enqueueDeviceBlockerSet({
      subsystemId: 123,
      deviceName: 'UL9_9_VFD1',
      party: 'Mechanical',
      description: 'VFD turns on, drive shaft moves, belt is slipping',
      updatedBy: 'Nika Partenadze',
    })
    expect(id).toBeGreaterThan(0)

    const rows = listDeviceBlockerSyncs()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.id).toBe(id)
    expect(row.subsystemId).toBe(123)
    expect(row.deviceName).toBe('UL9_9_VFD1')
    expect(row.op).toBe('set')
    expect(row.blockerResponsibleParty).toBe('Mechanical')
    expect(row.blockerDescription).toBe('VFD turns on, drive shaft moves, belt is slipping')
    expect(row.expectedParty).toBeNull()
    expect(row.expectedDescription).toBeNull()
    expect(row.updatedBy).toBe('Nika Partenadze')
    expect(row.timestamp).toBeTruthy()
    expect(row.retryCount).toBe(0)
    expect(row.lastError).toBeNull()
  })

  it('enqueueDeviceBlockerSet tolerates a missing updatedBy', () => {
    const id = enqueueDeviceBlockerSet({
      subsystemId: 1,
      deviceName: 'X',
      party: 'Controls',
      description: 'VFD did not turn on',
    })
    const row = listDeviceBlockerSyncs().find(r => r.id === id)!
    expect(row.updatedBy).toBeNull()
  })

  it('enqueueDeviceBlockerClear stores the expected pair on an Op=clear row', () => {
    const id = enqueueDeviceBlockerClear({
      subsystemId: 123,
      deviceName: 'UL9_9_VFD1',
      expectedParty: 'Mechanical',
      expectedDescription: 'VFD turns on, drive shaft moves, belt is slipping',
      updatedBy: 'Nika Partenadze',
    })
    const row = listDeviceBlockerSyncs().find(r => r.id === id)!
    expect(row.op).toBe('clear')
    expect(row.expectedParty).toBe('Mechanical')
    expect(row.expectedDescription).toBe('VFD turns on, drive shaft moves, belt is slipping')
    // set-only columns stay null on a clear op
    expect(row.blockerResponsibleParty).toBeNull()
    expect(row.blockerDescription).toBeNull()
  })

  it('listDeviceBlockerSyncs returns rows oldest-first', () => {
    const first = enqueueDeviceBlockerSet({ subsystemId: 1, deviceName: 'A', party: 'Controls', description: 'VFD did not turn on' })
    const second = enqueueDeviceBlockerSet({ subsystemId: 1, deviceName: 'B', party: 'Electrical', description: 'VFD Faults Immediately' })
    const third = enqueueDeviceBlockerSet({ subsystemId: 1, deviceName: 'C', party: 'Mechanical', description: "VFD turns on, drive shaft doesn't move" })

    const ids = listDeviceBlockerSyncs().map(r => r.id)
    // CreatedAt has 1s resolution → tie-break on id ASC keeps insert order.
    expect(ids).toEqual([first, second, third])
  })

  it('listDeviceBlockerSyncs honours the limit', () => {
    enqueueDeviceBlockerSet({ subsystemId: 1, deviceName: 'A', party: 'Controls', description: 'VFD did not turn on' })
    enqueueDeviceBlockerSet({ subsystemId: 1, deviceName: 'B', party: 'Controls', description: 'VFD did not turn on' })
    enqueueDeviceBlockerSet({ subsystemId: 1, deviceName: 'C', party: 'Controls', description: 'VFD did not turn on' })
    expect(listDeviceBlockerSyncs(2)).toHaveLength(2)
  })

  it('deleteDeviceBlockerSync removes the row', () => {
    const id = enqueueDeviceBlockerSet({ subsystemId: 1, deviceName: 'A', party: 'Controls', description: 'VFD did not turn on' })
    expect(listDeviceBlockerSyncs()).toHaveLength(1)
    deleteDeviceBlockerSync(id)
    expect(listDeviceBlockerSyncs()).toHaveLength(0)
  })

  it('recordDeviceBlockerSyncFailure bumps RetryCount and sets LastError', () => {
    const id = enqueueDeviceBlockerSet({ subsystemId: 1, deviceName: 'A', party: 'Controls', description: 'VFD did not turn on' })
    recordDeviceBlockerSyncFailure(id, 'updatedCount=0')
    let row = listDeviceBlockerSyncs().find(r => r.id === id)!
    expect(row.retryCount).toBe(1)
    expect(row.lastError).toBe('updatedCount=0')

    recordDeviceBlockerSyncFailure(id, 'updatedCount=0 again')
    row = listDeviceBlockerSyncs().find(r => r.id === id)!
    expect(row.retryCount).toBe(2)
    expect(row.lastError).toBe('updatedCount=0 again')
  })

  it('recordDeviceBlockerSyncTransientFailure sets LastError WITHOUT burning a strike', () => {
    const id = enqueueDeviceBlockerSet({ subsystemId: 1, deviceName: 'A', party: 'Controls', description: 'VFD did not turn on' })
    recordDeviceBlockerSyncTransientFailure(id, 'offline')
    const row = listDeviceBlockerSyncs().find(r => r.id === id)!
    expect(row.retryCount).toBe(0)
    expect(row.lastError).toBe('offline')
  })

  // F7 (2026-07-03 sync audit): the blocker queue was the ONE queue with no
  // dead-letter — a permanently-rejected row re-POSTed every 10s forever.
  it('parkDeviceBlockerSync removes the row from the active drain but keeps it (never deleted)', () => {
    const id = enqueueDeviceBlockerSet({ subsystemId: 40, deviceName: 'UL9_9_VFD1', party: 'Controls', description: 'VFD did not turn on' })
    parkDeviceBlockerSync(id, 'cloud-rejected: bad-party — parked after 10 retries')

    expect(listDeviceBlockerSyncs()).toHaveLength(0) // excluded from drain
    const parked = listParkedDeviceBlockerSyncs()
    expect(parked).toHaveLength(1)
    expect(parked[0].id).toBe(id)
    expect(parked[0].lastError).toContain('parked after 10 retries')
    expect(countParkedDeviceBlockerSyncs()).toBe(1)
  })

  it('listParkedDeviceBlockerSyncs can scope by subsystem', () => {
    const a = enqueueDeviceBlockerSet({ subsystemId: 40, deviceName: 'A', party: 'Controls', description: 'x' })
    const b = enqueueDeviceBlockerSet({ subsystemId: 41, deviceName: 'B', party: 'Controls', description: 'x' })
    parkDeviceBlockerSync(a, 'err')
    parkDeviceBlockerSync(b, 'err')
    expect(listParkedDeviceBlockerSyncs(40).map(r => r.id)).toEqual([a])
  })

  it('unparkDeviceBlockerSync returns the row to the active drain with strikes cleared', () => {
    const id = enqueueDeviceBlockerSet({ subsystemId: 40, deviceName: 'A', party: 'Controls', description: 'x' })
    recordDeviceBlockerSyncFailure(id, 'strike')
    parkDeviceBlockerSync(id, 'parked')
    expect(listDeviceBlockerSyncs()).toHaveLength(0)

    unparkDeviceBlockerSync(id)
    const row = listDeviceBlockerSyncs().find(r => r.id === id)!
    expect(row.retryCount).toBe(0)
  })
})
