/**
 * Planned-date contract, local side (docs/PLANNED-DATES-CONTRACT.md):
 * cloud JSON `plannedDate: "YYYY-MM-DD" | null` → SQLite `Ios.PlannedDate TEXT`
 * (verbatim) → `ioToApi().plannedDate` for the grid. Cloud-owned, field
 * read-only — never enters PendingSyncs.
 *
 * This file imports the REAL db-sqlite module against an in-memory database
 * (storage-paths mocked), so it exercises the actual startup migration list —
 * including the `ALTER TABLE Ios ADD COLUMN PlannedDate TEXT` migration path —
 * and the real ioToApi whitelist (the /api/ios SELECT * goes through it; a
 * column missing there is invisible to the client).
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/storage-paths', () => ({
  resolveDatabasePath: () => ':memory:',
}))

vi.spyOn(console, 'log').mockImplementation(() => {})

import { db, ioToApi, type Io } from '@/lib/db-sqlite'

describe('PlannedDate — schema + API mapping', () => {
  it('startup schema/migrations produce Ios.PlannedDate (TEXT, nullable)', () => {
    const cols = db.prepare('PRAGMA table_info(Ios)').all() as Array<{ name: string; type: string; notnull: number }>
    const pd = cols.find(c => c.name === 'PlannedDate')
    expect(pd).toBeDefined()
    expect(pd!.type).toBe('TEXT')
    expect(pd!.notnull).toBe(0)
  })

  it('round-trips the date string verbatim: insert → SELECT * → ioToApi().plannedDate', () => {
    db.prepare('INSERT OR IGNORE INTO Projects (id, Name) VALUES (1, ?)').run('P')
    db.prepare('INSERT OR IGNORE INTO Subsystems (id, ProjectId, Name) VALUES (1, 1, ?)').run('MCM99')
    db.prepare('INSERT INTO Ios (id, Name, SubsystemId, PlannedDate) VALUES (?, ?, ?, ?)')
      .run(900001, 'IO_PLANNED', 1, '2026-08-03')
    const row = db.prepare('SELECT * FROM Ios WHERE id = ?').get(900001) as Io
    expect(row.PlannedDate).toBe('2026-08-03') // stored verbatim, no Date coercion
    expect(ioToApi(row).plannedDate).toBe('2026-08-03')
  })

  it('maps a missing date to null (not undefined) in the API shape', () => {
    db.prepare('INSERT OR IGNORE INTO Projects (id, Name) VALUES (1, ?)').run('P')
    db.prepare('INSERT OR IGNORE INTO Subsystems (id, ProjectId, Name) VALUES (1, 1, ?)').run('MCM99')
    db.prepare('INSERT INTO Ios (id, Name, SubsystemId) VALUES (?, ?, ?)').run(900002, 'IO_UNPLANNED', 1)
    const row = db.prepare('SELECT * FROM Ios WHERE id = ?').get(900002) as Io
    expect(ioToApi(row).plannedDate).toBeNull()
  })
})
