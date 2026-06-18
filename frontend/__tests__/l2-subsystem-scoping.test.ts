/**
 * Per-MCM scoping for FV/L2 data (2026-06-18 "FV shows only one MCM" fix).
 *
 * L2 used to be a single global dataset: pull-l2 did DELETE FROM L2* (everything)
 * then reloaded ONE subsystem, so a central server hosting many MCMs could only
 * ever hold one MCM's FV data — and every pull silently wiped the others
 * (a data-loss path on top of the display bug). The fix scopes devices/cells by
 * L2Devices.SubsystemId so pulls ACCUMULATE per MCM.
 *
 * Tested against the EXACT SQL the routes use, on an in-memory DB (mirrors
 * l2-pending-sync-deadletter.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

let db: Database.Database

// The scoped DELETE pull-l2 runs (cells first — FK cascade isn't guaranteed).
function scopedDelete(sid: number) {
  db.prepare(
    'DELETE FROM L2CellValues WHERE DeviceId IN (SELECT id FROM L2Devices WHERE SubsystemId = ? OR SubsystemId IS NULL)',
  ).run(sid)
  db.prepare('DELETE FROM L2Devices WHERE SubsystemId = ? OR SubsystemId IS NULL').run(sid)
}
// The scoped read GET /api/l2?subsystemId= runs.
function scopedDevices(sid: number) {
  return db
    .prepare('SELECT * FROM L2Devices WHERE SubsystemId = ? OR SubsystemId IS NULL ORDER BY DisplayOrder')
    .all(sid) as Array<{ id: number; DeviceName: string; SubsystemId: number | null }>
}

function addDevice(sid: number | null, name: string): number {
  const r = db
    .prepare('INSERT INTO L2Devices (SubsystemId, SheetId, DeviceName, DisplayOrder) VALUES (?, 1, ?, 0)')
    .run(sid, name)
  const devId = Number(r.lastInsertRowid)
  db.prepare('INSERT INTO L2CellValues (DeviceId, ColumnId, Value, Version) VALUES (?, 1, ?, 1)').run(
    devId,
    `val-${name}`,
  )
  return devId
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE L2Devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudId INTEGER, SubsystemId INTEGER, SheetId INTEGER NOT NULL,
      DeviceName TEXT NOT NULL, Mcm TEXT, Subsystem TEXT, DisplayOrder INTEGER NOT NULL,
      CompletedChecks INTEGER DEFAULT 0, TotalChecks INTEGER DEFAULT 0
    );
    CREATE TABLE L2CellValues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudCellId INTEGER, DeviceId INTEGER NOT NULL, ColumnId INTEGER NOT NULL,
      Value TEXT, UpdatedBy TEXT, UpdatedAt TEXT, Version INTEGER DEFAULT 0,
      UNIQUE(DeviceId, ColumnId)
    );
  `)
})

describe('L2 per-MCM scoping', () => {
  it('a scoped pull of one MCM does NOT wipe another MCM (no cross-wipe)', () => {
    const a = addDevice(38, 'MCM02-VFD1')
    const b = addDevice(47, 'MCM11-VFD1')

    // Re-pull MCM 38 (the destructive part of pull-l2, scoped to 38).
    scopedDelete(38)

    // 38 gone, 47 fully intact (device + its cell).
    expect(db.prepare('SELECT COUNT(*) c FROM L2Devices WHERE SubsystemId = 38').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) c FROM L2Devices WHERE id = ?').get(b)).toEqual({ c: 1 })
    expect(db.prepare('SELECT COUNT(*) c FROM L2CellValues WHERE DeviceId = ?').get(b)).toEqual({ c: 1 })
    expect(db.prepare('SELECT COUNT(*) c FROM L2CellValues WHERE DeviceId = ?').get(a)).toEqual({ c: 0 })
  })

  it('the scoped read returns only the requested MCM (plus legacy NULL rows)', () => {
    addDevice(38, 'MCM02-VFD1')
    addDevice(47, 'MCM11-VFD1')
    const legacy = addDevice(null, 'LEGACY-pre-migration')

    const for38 = scopedDevices(38).map((d) => d.DeviceName).sort()
    expect(for38).toEqual(['LEGACY-pre-migration', 'MCM02-VFD1']) // NOT MCM11
    const for47 = scopedDevices(47).map((d) => d.DeviceName).sort()
    expect(for47).toEqual(['LEGACY-pre-migration', 'MCM11-VFD1']) // NOT MCM02
    expect(legacy).toBeGreaterThan(0)
  })

  it('a scoped pull cleans up legacy NULL rows (re-stamps on next pull)', () => {
    addDevice(null, 'LEGACY')
    addDevice(47, 'MCM11-VFD1')
    // Pulling subsystem 38 deletes its own + the legacy NULL rows, leaving 47.
    scopedDelete(38)
    const remaining = db.prepare('SELECT DeviceName FROM L2Devices ORDER BY DeviceName').all() as Array<{ DeviceName: string }>
    expect(remaining.map((r) => r.DeviceName)).toEqual(['MCM11-VFD1'])
  })
})
