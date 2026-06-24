import { describe, it, expect, beforeEach, vi } from 'vitest'

// Fresh in-memory DB with the verbatim SyncCursors DDL — never touches the real
// database file (same pattern as device-blocker-sync.test.ts).
const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE IF NOT EXISTS SyncCursors (
      SubsystemId INTEGER PRIMARY KEY,
      LastSeq     INTEGER NOT NULL DEFAULT 0,
      UpdatedAt   TEXT DEFAULT (datetime('now'))
    );
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))

import { getSyncCursor, setSyncCursor } from '@/lib/cloud/sync-cursor'

describe('sync-cursor repository', () => {
  beforeEach(() => memDb.exec('DELETE FROM SyncCursors'))

  it('returns 0 for an unknown subsystem', () => {
    expect(getSyncCursor(42)).toBe(0)
  })

  it('stores and reads back a cursor', () => {
    setSyncCursor(42, 137)
    expect(getSyncCursor(42)).toBe(137)
  })

  it('advances forward but never rewinds', () => {
    setSyncCursor(42, 137)
    setSyncCursor(42, 100) // stale/out-of-order — ignored
    expect(getSyncCursor(42)).toBe(137)
    setSyncCursor(42, 200)
    expect(getSyncCursor(42)).toBe(200)
  })

  it('tracks cursors per subsystem independently', () => {
    setSyncCursor(1, 10)
    setSyncCursor(2, 20)
    expect(getSyncCursor(1)).toBe(10)
    expect(getSyncCursor(2)).toBe(20)
  })
})
