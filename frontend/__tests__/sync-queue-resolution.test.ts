/**
 * SYNC CENTER — full resolution PROOF (2026-07-15).
 *
 * Proves the operator-facing Sync Center (`lib/sync/queue-inspector.ts`) can
 * UNSTICK every kind of stuck outbound-queue row, no matter HOW it got stuck,
 * and that neither resolution path can ever lose field data.
 *
 * The proof is a MATRIX: every outbound queue kind {io, l2, blocker} × every
 * error classification {gone_on_cloud, version_conflict, transient, unknown},
 * with two representative raw LastError strings per classification. For each
 * cell we prove, end to end:
 *   1. listQueue({status:'parked'}) SURFACES the row with the expected
 *      classification, a non-empty human reason, and a resolved title/subtitle.
 *   2. retry()   → the row is UN-parked (DeadLettered=0, RetryCount=0,
 *      LastError NULL) so auto-sync re-attempts it. affected = 1.
 *   3. discard() → the QUEUE row is gone but the UNDERLYING data-table value
 *      (Ios / L2CellValues / Devices) is UNTOUCHED — the data-loss proof.
 *   4. Bulk selectRefs({allParked}) and selectRefs({classification}) resolve to
 *      exactly the right rows, and retry/discard through them works.
 *
 * Harness matches the existing deadletter/coverage tests: the @/lib/db-sqlite
 * singleton is mocked to a throwaway in-memory better-sqlite3 DB carrying the
 * three queue tables plus the minimal data tables the queue-inspector label
 * LEFT JOINs need. queue-inspector itself is exercised REAL.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    -- ── Data tables (the real values live here; queue rows are outbound copies) ──
    CREATE TABLE Ios (id INTEGER PRIMARY KEY, Name TEXT, Description TEXT, Result TEXT, SubsystemId INTEGER);
    CREATE TABLE L2Devices (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, DeviceName TEXT, Mcm TEXT, SubsystemId INTEGER);
    CREATE TABLE L2Columns (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, Name TEXT);
    CREATE TABLE L2CellValues (id INTEGER PRIMARY KEY AUTOINCREMENT, DeviceId INTEGER, ColumnId INTEGER, Value TEXT);
    CREATE TABLE Devices (id INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT,
      BlockerResponsibleParty TEXT, BlockerDescription TEXT);
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY, Name TEXT);

    -- ── The three OUTBOUND queue tables the Sync Center triages ──
    CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, TestResult TEXT,
      RetryCount INTEGER DEFAULT 0, LastError TEXT, CreatedAt TEXT DEFAULT (datetime('now')),
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudDeviceId INTEGER,
      CloudColumnId INTEGER, Value TEXT, UpdatedBy TEXT, Version INTEGER DEFAULT 0,
      CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE DeviceBlockerPendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      DeviceName TEXT, Op TEXT, BlockerResponsibleParty TEXT, BlockerDescription TEXT, UpdatedBy TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Orphaned INTEGER NOT NULL DEFAULT 0);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))

import { listQueue, classify, retry, discard, selectRefs, type QueueKind, type Classification } from '@/lib/sync/queue-inspector'

// ── Fixed cloud back-ref ids so the L2 device/column label joins resolve ──
const CLOUD_DEV = 500
const CLOUD_COL = 20
const IO_ID = 1

/** Idempotently (re)create the underlying DATA rows a queue row points at. */
function seedData() {
  memDb.prepare("INSERT OR IGNORE INTO Subsystems (id, Name) VALUES (40, 'MCM04'), (47, 'MCM11')").run()
  memDb.prepare("INSERT OR IGNORE INTO Ios (id, Name, Description, Result, SubsystemId) VALUES (?, 'DI_START_PB', 'Start pushbutton', 'Passed', 47)").run(IO_ID)
  memDb.prepare('INSERT OR IGNORE INTO L2Devices (id, CloudId, DeviceName, Mcm, SubsystemId) VALUES (1, ?, ?, ?, 47)').run(CLOUD_DEV, 'M-101', 'MCM11')
  memDb.prepare('INSERT OR IGNORE INTO L2Columns (id, CloudId, Name) VALUES (1, ?, ?)').run(CLOUD_COL, 'Run Verified')
  memDb.prepare('INSERT OR IGNORE INTO L2CellValues (id, DeviceId, ColumnId, Value) VALUES (1, 1, 1, ?)').run('true')
  memDb.prepare("INSERT OR IGNORE INTO Devices (id, Name, BlockerResponsibleParty, BlockerDescription) VALUES (1, 'VFD-7', 'Electrical', 'awaiting power')").run()
}

/** Seed one PARKED queue row of `kind` with `lastError`. Returns its id. */
function seedParked(kind: QueueKind, lastError: string | null, retryCount = 7): number {
  seedData()
  let info
  if (kind === 'io') {
    info = memDb.prepare('INSERT INTO PendingSyncs (IoId, TestResult, RetryCount, LastError, DeadLettered) VALUES (?, ?, ?, ?, 1)')
      .run(IO_ID, 'Passed', retryCount, lastError)
  } else if (kind === 'l2') {
    info = memDb.prepare('INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, RetryCount, LastError, DeadLettered) VALUES (?, ?, ?, ?, ?, 1)')
      .run(CLOUD_DEV, CLOUD_COL, 'true', retryCount, lastError)
  } else {
    info = memDb.prepare("INSERT INTO DeviceBlockerPendingSyncs (SubsystemId, DeviceName, Op, BlockerResponsibleParty, BlockerDescription, RetryCount, LastError, DeadLettered) VALUES (40, 'VFD-7', 'set', 'Electrical', 'awaiting power', ?, ?, 1)")
      .run(retryCount, lastError)
  }
  return Number(info.lastInsertRowid)
}

/** Seed one ACTIVE (not parked) io queue row — must never appear in parked selectors. */
function seedActiveIo(): number {
  seedData()
  const info = memDb.prepare('INSERT INTO PendingSyncs (IoId, TestResult, RetryCount, LastError, DeadLettered) VALUES (?, ?, 0, NULL, 0)')
    .run(IO_ID, 'Passed')
  return Number(info.lastInsertRowid)
}

const TABLE: Record<QueueKind, string> = {
  io: 'PendingSyncs', l2: 'L2PendingSyncs', blocker: 'DeviceBlockerPendingSyncs',
}
const queueRow = (kind: QueueKind, id: number): any =>
  memDb.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id)

/** The underlying data row a discard must NEVER delete, per kind. */
function underlyingDataRow(kind: QueueKind): any {
  if (kind === 'io') return memDb.prepare('SELECT * FROM Ios WHERE id = ?').get(IO_ID)
  if (kind === 'l2') return memDb.prepare('SELECT * FROM L2CellValues WHERE DeviceId = 1 AND ColumnId = 1').get()
  return memDb.prepare("SELECT * FROM Devices WHERE Name = 'VFD-7'").get()
}
const DATA_LABEL: Record<QueueKind, string> = { io: 'IO value', l2: 'L2 cell value', blocker: 'device blocker value' }

beforeEach(() => {
  for (const t of ['PendingSyncs', 'L2PendingSyncs', 'DeviceBlockerPendingSyncs', 'Ios', 'L2Devices', 'L2Columns', 'L2CellValues', 'Devices', 'Subsystems']) {
    memDb.exec(`DELETE FROM ${t}`)
  }
})

// ── The classification matrix: two raw LastError strings per class ──
const MATRIX: Array<{ classification: Classification; errors: Array<{ label: string; value: string | null }> }> = [
  { classification: 'gone_on_cloud',    errors: [{ label: 'HTTP 404', value: 'HTTP 404' },                     { label: 'HTTP 403', value: 'HTTP 403' }] },
  { classification: 'version_conflict', errors: [{ label: 'rebased', value: 'rebased after version conflict' }, { label: 'HTTP 409', value: 'HTTP 409' }] },
  { classification: 'transient',        errors: [{ label: 'timeout', value: 'timeout' },                        { label: 'ECONNREFUSED', value: 'ECONNREFUSED' }] },
  { classification: 'unknown',          errors: [{ label: 'empty/null', value: null },                          { label: 'weird error', value: 'some weird error' }] },
]

const KINDS: QueueKind[] = ['io', 'l2', 'blocker']

// ─────────────────────────────────────────────────────────────────────────
// PROOF MATRIX — kind × classification × error string
// ─────────────────────────────────────────────────────────────────────────
describe('Sync Center resolution PROOF MATRIX — every stuck row is retryable, discardable, and never loses data', () => {
  for (const kind of KINDS) {
    for (const { classification, errors } of MATRIX) {
      for (const err of errors) {
        it(`${kind} / ${classification} [${err.label}]: parked row is surfaced, retryable, discardable — and discard never deletes the ${DATA_LABEL[kind]}`, () => {
          // (0) sanity: the raw error classifies as expected before we even queue it
          expect(classify(err.value).classification).toBe(classification)

          // (1) SURFACED with the expected classification + human reason + resolved labels
          const id1 = seedParked(kind, err.value)
          const parked = listQueue({ status: 'parked' }).items
          const item = parked.find((i) => i.kind === kind && i.id === id1)
          expect(item, 'parked row must appear in listQueue({status:parked})').toBeTruthy()
          expect(item!.status).toBe('parked')
          expect(item!.classification).toBe(classification)
          expect(item!.reason.length).toBeGreaterThan(0)   // never a blank reason
          expect(item!.title.length).toBeGreaterThan(0)    // label join resolved a title
          expect(item!.subtitle && item!.subtitle.length).toBeGreaterThan(0) // ...and a subtitle
          expect(item!.retryCount).toBe(7)

          // (2) RETRY un-parks the row so auto-sync re-attempts it
          const r = retry([{ kind, id: id1 }])
          expect(r.affected).toBe(1)
          const rowA = queueRow(kind, id1)
          expect(rowA.DeadLettered).toBe(0)
          expect(rowA.RetryCount).toBe(0)
          expect(rowA.LastError).toBeNull()

          // (3) DISCARD removes the QUEUE row only — underlying data survives (DATA-LOSS PROOF)
          const id2 = seedParked(kind, err.value)
          const dataBefore = underlyingDataRow(kind)
          expect(dataBefore).toBeTruthy()
          const d = discard([{ kind, id: id2 }])
          expect(d.affected).toBe(1)
          expect(queueRow(kind, id2)).toBeUndefined()          // queue row gone
          const dataAfter = underlyingDataRow(kind)
          expect(dataAfter).toBeTruthy()                       // underlying row STILL EXISTS
          expect(dataAfter).toEqual(dataBefore)                // ...byte-for-byte untouched
        })
      }
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────
// BULK selectors — allParked and by-classification resolve + resolve safely
// ─────────────────────────────────────────────────────────────────────────
describe('Sync Center bulk selectors resolve to the right rows and never touch active work or data', () => {
  it('selectRefs({allParked}) resolves EVERY parked row across all three queues (and skips active rows)', () => {
    const ioGone = seedParked('io', 'HTTP 404')
    const l2Conf = seedParked('l2', 'HTTP 409')
    const blkTrans = seedParked('blocker', 'timeout')
    const activeIo = seedActiveIo() // NOT parked — must be excluded

    const refs = selectRefs({ allParked: true })
    expect(refs).toHaveLength(3)
    expect(refs).toContainEqual({ kind: 'io', id: ioGone })
    expect(refs).toContainEqual({ kind: 'l2', id: l2Conf })
    expect(refs).toContainEqual({ kind: 'blocker', id: blkTrans })
    expect(refs.some((r) => r.id === activeIo && r.kind === 'io')).toBe(false)

    // discard through the bulk selection: all parked queue rows go, the active
    // row stays, and every underlying data value survives.
    const d = discard(refs)
    expect(d.affected).toBe(3)
    expect(queueRow('io', ioGone)).toBeUndefined()
    expect(queueRow('l2', l2Conf)).toBeUndefined()
    expect(queueRow('blocker', blkTrans)).toBeUndefined()
    expect(queueRow('io', activeIo)).toBeTruthy()             // active work untouched
    expect(underlyingDataRow('io')).toBeTruthy()
    expect(underlyingDataRow('l2')).toBeTruthy()
    expect(underlyingDataRow('blocker')).toBeTruthy()
  })

  it('selectRefs({classification:"gone_on_cloud"}) resolves ONLY the gone rows, and retry un-parks exactly those', () => {
    const ioGone = seedParked('io', 'HTTP 404')       // gone
    const blkGone = seedParked('blocker', 'HTTP 403') // gone
    const l2Conf = seedParked('l2', 'HTTP 409')       // version_conflict — must NOT match
    const ioTrans = seedParked('io', 'timeout')       // transient — must NOT match

    const refs = selectRefs({ classification: 'gone_on_cloud' })
    expect(refs).toHaveLength(2)
    expect(refs).toContainEqual({ kind: 'io', id: ioGone })
    expect(refs).toContainEqual({ kind: 'blocker', id: blkGone })

    const r = retry(refs)
    expect(r.affected).toBe(2)
    expect(queueRow('io', ioGone).DeadLettered).toBe(0)       // gone rows un-parked
    expect(queueRow('blocker', blkGone).DeadLettered).toBe(0)
    expect(queueRow('l2', l2Conf).DeadLettered).toBe(1)       // non-matching rows still parked
    expect(queueRow('io', ioTrans).DeadLettered).toBe(1)
  })

  it('summary counts pending vs parked and buckets by classification', () => {
    seedParked('io', 'HTTP 404')
    seedParked('l2', 'HTTP 409')
    seedActiveIo()
    const { summary } = listQueue()
    expect(summary.parked).toBe(2)
    expect(summary.pending).toBe(1)
    expect(summary.byClassification.gone_on_cloud).toBe(1)
    expect(summary.byClassification.version_conflict).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// PER-MCM SCOPING — an operator on MCM05 must never touch MCM01's queue.
// This is the data-safety guarantee behind the per-MCM Sync Center.
// ─────────────────────────────────────────────────────────────────────────
/** Seed a parked IO queue row for a specific subsystem/MCM. Returns the queue-row id. */
function seedParkedIoOnSubsystem(subsystemId: number, ioId: number, lastError: string | null): number {
  memDb.prepare('INSERT OR IGNORE INTO Subsystems (id, Name) VALUES (?, ?)').run(subsystemId, `MCM-${subsystemId}`)
  memDb.prepare("INSERT OR IGNORE INTO Ios (id, Name, Description, Result, SubsystemId) VALUES (?, ?, 'x', 'Passed', ?)").run(ioId, `IO_${ioId}`, subsystemId)
  const info = memDb.prepare('INSERT INTO PendingSyncs (IoId, TestResult, RetryCount, LastError, DeadLettered) VALUES (?, ?, 5, ?, 1)').run(ioId, 'Passed', lastError)
  return Number(info.lastInsertRowid)
}

describe('Sync Center PER-MCM scoping — one MCM never touches another', () => {
  it('listQueue({subsystemId}) surfaces + attributes ONLY that MCM, and the summary is scoped too', () => {
    const mcm11Io = seedParkedIoOnSubsystem(47, 11, 'HTTP 409')
    const mcm04Io = seedParkedIoOnSubsystem(40, 40, 'HTTP 409')

    const scoped = listQueue({ subsystemId: 47 })
    expect(scoped.items.every((i) => i.subsystemId === 47)).toBe(true)
    expect(scoped.items.every((i) => i.mcm === 'MCM-47')).toBe(true) // attribution present
    expect(scoped.items.some((i) => i.kind === 'io' && i.id === mcm11Io)).toBe(true)
    expect(scoped.items.some((i) => i.id === mcm04Io)).toBe(false)   // MCM04 invisible
    expect(scoped.summary.parked).toBe(1)                            // summary scoped to MCM11
  })

  it('THE HAZARD FIX: bulk discard scoped to MCM04 leaves MCM11’s stuck row completely intact', () => {
    const mcm11Io = seedParkedIoOnSubsystem(47, 11, 'HTTP 404')
    const mcm04Io = seedParkedIoOnSubsystem(40, 40, 'HTTP 404')
    const mcm04Blk = seedParked('blocker', 'HTTP 404') // seedParked seeds the blocker on SubsystemId 40

    const refs04 = selectRefs({ allParked: true, subsystemId: 40 })
    expect(refs04).toContainEqual({ kind: 'io', id: mcm04Io })
    expect(refs04).toContainEqual({ kind: 'blocker', id: mcm04Blk })
    expect(refs04.some((r) => r.kind === 'io' && r.id === mcm11Io)).toBe(false) // MCM11 excluded

    discard(refs04)
    expect(queueRow('io', mcm04Io)).toBeUndefined()   // MCM04 cleared
    expect(queueRow('blocker', mcm04Blk)).toBeUndefined()
    expect(queueRow('io', mcm11Io)).toBeTruthy()       // ← MCM11 UNTOUCHED (the guarantee)
  })

  it('global bulk (no subsystemId) still resolves EVERY MCM — the all-MCM path is unchanged', () => {
    const mcm11Io = seedParkedIoOnSubsystem(47, 11, 'timeout')
    const mcm04Io = seedParkedIoOnSubsystem(40, 40, 'timeout')
    const refs = selectRefs({ allParked: true })
    expect(refs).toContainEqual({ kind: 'io', id: mcm11Io })
    expect(refs).toContainEqual({ kind: 'io', id: mcm04Io })
  })
})
