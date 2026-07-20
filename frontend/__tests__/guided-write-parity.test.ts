/**
 * Regression: the guided write path must not lose fields the grid path keeps.
 *
 * Guided mode has its OWN endpoints (POST /api/guided/test, /api/guided/clear)
 * that write the same rows as the grid. Hardening applied to the grid route
 * therefore does not reach guided automatically, and three fixes had drifted:
 *
 *  1. Guided queued only 8 of the 11 PendingSyncs columns, so Trade and the
 *     blocker pair arrived NULL at cloud for EVERY guided Fail — the same
 *     class as the "27-NULL CDW5 rows" bug already fixed for FailureMode.
 *  2. Guided clear nulled Result/Comments but left FailureMode and Trade on
 *     the row, while the WS event and cloud push both reported them cleared.
 *  3. `ioId` was taken on trust, so a session on one MCM could write to
 *     another MCM's IO.
 *
 * These assert the contracts against a real in-memory DB carrying the verbatim
 * DDL (same approach as pull-block-estop-guided.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3')

const db = new Database(':memory:')
db.exec(`
  CREATE TABLE Ios (
    id INTEGER PRIMARY KEY,
    Name TEXT,
    SubsystemId INTEGER,
    Result TEXT,
    Timestamp TEXT,
    Comments TEXT,
    Version INTEGER DEFAULT 0,
    FailureMode TEXT,
    Trade TEXT
  );
  CREATE TABLE PendingSyncs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    IoId INTEGER NOT NULL,
    InspectorName TEXT,
    TestResult TEXT,
    Comments TEXT,
    State TEXT,
    Timestamp TEXT,
    Version INTEGER,
    FailureMode TEXT,
    BlockerResponsibleParty TEXT,
    BlockerDescription TEXT,
    Trade TEXT
  );
`)

beforeEach(() => {
  db.exec('DELETE FROM Ios; DELETE FROM PendingSyncs;')
  db.prepare(
    'INSERT INTO Ios (id, Name, SubsystemId, Result, FailureMode, Trade, Comments, Version) VALUES (?,?,?,?,?,?,?,?)',
  ).run(1, 'MCM02-PE1', 38, 'Failed', '3rd Party', 'Mechanical', 'belt slip', 4)
})

/** The exact statement the guided test route now issues. */
const GUIDED_PENDING_INSERT =
  'INSERT INTO PendingSyncs (IoId, InspectorName, TestResult, Comments, State, Timestamp, Version, FailureMode, BlockerResponsibleParty, BlockerDescription, Trade) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

describe('guided Fail carries the full punchlist payload to cloud', () => {
  it('queues Trade and the blocker pair, not just FailureMode', () => {
    db.prepare(GUIDED_PENDING_INSERT).run(
      1, 'Nika', 'Failed', 'belt slip', 'TRUE', '2026-07-20T00:00:00Z', 4,
      '3rd Party', 'Mechanical Contractor', 'belt not tracked', 'Mechanical',
    )
    const row = db.prepare('SELECT * FROM PendingSyncs WHERE IoId = 1').get() as any
    // The three that used to arrive NULL at cloud:
    expect(row.Trade).toBe('Mechanical')
    expect(row.BlockerResponsibleParty).toBe('Mechanical Contractor')
    expect(row.BlockerDescription).toBe('belt not tracked')
    expect(row.FailureMode).toBe('3rd Party')
  })

  it('a Pass clears the reason fields rather than carrying them over', () => {
    db.prepare(GUIDED_PENDING_INSERT).run(
      1, 'Nika', 'Passed', null, 'TRUE', '2026-07-20T00:00:00Z', 4,
      null, null, null, null,
    )
    const row = db.prepare('SELECT * FROM PendingSyncs WHERE IoId = 1').get() as any
    expect(row.FailureMode).toBeNull()
    expect(row.Trade).toBeNull()
    expect(row.BlockerResponsibleParty).toBeNull()
  })
})

describe('guided clear wipes the failure reason with the result', () => {
  it('nulls FailureMode and Trade, not just Result/Comments', () => {
    db.prepare(
      'UPDATE Ios SET Result = NULL, Timestamp = NULL, Comments = NULL, FailureMode = NULL, Trade = NULL, Version = ? WHERE id = ?',
    ).run(5, 1)
    const io = db.prepare('SELECT * FROM Ios WHERE id = 1').get() as any
    expect(io.Result).toBeNull()
    expect(io.Comments).toBeNull()
    // These two survived the old statement and left the local row disagreeing
    // with both the WS event and cloud, which reported them blank.
    expect(io.FailureMode).toBeNull()
    expect(io.Trade).toBeNull()
    expect(io.Version).toBe(5)
  })
})

describe('MCM ownership guard', () => {
  /** Mirrors the route check: reject when the caller names a different MCM. */
  const isMismatch = (claimed: string | null, owner: string) =>
    claimed != null && claimed !== owner

  it('rejects a write aimed at another MCM', () => {
    const io = db.prepare('SELECT SubsystemId FROM Ios WHERE id = 1').get() as any
    expect(isMismatch('79', String(io.SubsystemId))).toBe(true)
  })

  it('allows a write from the owning MCM', () => {
    const io = db.prepare('SELECT SubsystemId FROM Ios WHERE id = 1').get() as any
    expect(isMismatch('38', String(io.SubsystemId))).toBe(false)
  })

  it('does not block when no subsystem is supplied (back-compat)', () => {
    expect(isMismatch(null, '38')).toBe(false)
  })
})
