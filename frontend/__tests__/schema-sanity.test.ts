/**
 * Runtime schema sanity sweep — "are the tables I expect still there, and the
 * DDL shapes that caused shipped data-loss bugs still gone?"
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  return { memDb: new Database(':memory:') }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
const auditLogSpy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: auditLogSpy }))

import { runSchemaSanity } from '@/lib/db/schema-sanity'

/** Minimal-but-complete critical schema (tables + the columns the sweep checks). */
function createFullSchema() {
  memDb.exec(`
    CREATE TABLE Projects (id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY, ProjectId INTEGER, Name TEXT);
    CREATE TABLE Ios (id INTEGER PRIMARY KEY, Result TEXT, Version INTEGER, SubsystemId INTEGER, Comments TEXT);
    CREATE TABLE TestHistories (id INTEGER PRIMARY KEY, IoId INTEGER NOT NULL, Result TEXT, Timestamp TEXT NOT NULL);
    CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY, IoId INTEGER, TestResult TEXT, Version INTEGER, DeadLettered INTEGER);
    CREATE TABLE L2Sheets (id INTEGER PRIMARY KEY, CloudId INTEGER);
    CREATE TABLE L2Columns (id INTEGER PRIMARY KEY, CloudId INTEGER);
    CREATE TABLE L2Devices (id INTEGER PRIMARY KEY, CloudId INTEGER, SheetId INTEGER, SubsystemId INTEGER);
    CREATE TABLE L2CellValues (id INTEGER PRIMARY KEY, DeviceId INTEGER, ColumnId INTEGER, Value TEXT, Version INTEGER);
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY, CloudDeviceId INTEGER, CloudColumnId INTEGER, DeadLettered INTEGER);
    CREATE TABLE EStopZones (id INTEGER PRIMARY KEY, SubsystemId INTEGER);
    CREATE TABLE EStopEpcChecks (id INTEGER PRIMARY KEY, SubsystemId INTEGER, ZoneName TEXT, CheckTag TEXT, CheckType TEXT, Version INTEGER);
    CREATE TABLE EStopCheckPendingSyncs (id INTEGER PRIMARY KEY, SubsystemId INTEGER);
    CREATE TABLE SyncCursors (SubsystemId INTEGER PRIMARY KEY, LastSeq INTEGER);
    CREATE TABLE ChangeRequests (id INTEGER PRIMARY KEY, CloudId INTEGER, Status TEXT);
  `)
}

function dropAllTables() {
  const tables = memDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  for (const t of tables) memDb.exec(`DROP TABLE IF EXISTS "${t.name}"`)
}

describe('runSchemaSanity', () => {
  beforeEach(() => {
    dropAllTables()
    auditLogSpy.mockClear()
  })

  it('passes on a complete schema and journals nothing', () => {
    createFullSchema()
    const r = runSchemaSanity()
    expect(r.ok).toBe(true)
    expect(r.problems).toEqual([])
    expect(auditLogSpy).not.toHaveBeenCalled()
  })

  it('flags a missing critical table and journals db.sanity', () => {
    createFullSchema()
    memDb.exec('DROP TABLE L2CellValues')
    const r = runSchemaSanity()
    expect(r.ok).toBe(false)
    expect(r.problems).toContain('missing table: L2CellValues')
    expect(auditLogSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'db.sanity' }))
  })

  it('flags a missing critical column (failed migration shape)', () => {
    createFullSchema()
    memDb.exec('ALTER TABLE PendingSyncs DROP COLUMN DeadLettered')
    const r = runSchemaSanity()
    expect(r.ok).toBe(false)
    expect(r.problems).toContain('missing column: PendingSyncs.DeadLettered')
  })

  it('flags the forbidden TestHistories ON DELETE CASCADE (regression guard for the 2026-07-08 fix)', () => {
    createFullSchema()
    memDb.exec('DROP TABLE TestHistories')
    memDb.exec(`CREATE TABLE TestHistories (
      id INTEGER PRIMARY KEY,
      IoId INTEGER NOT NULL REFERENCES Ios(id) ON DELETE CASCADE,
      Result TEXT, Timestamp TEXT NOT NULL
    )`)
    const r = runSchemaSanity()
    expect(r.ok).toBe(false)
    expect(r.problems.some((p) => p.startsWith('forbidden DDL on TestHistories'))).toBe(true)
  })
})
