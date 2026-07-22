import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * GET /api/vfd-commissioning/state is PER-MCM.
 *
 * FILE UNDER TEST: app/api/vfd-commissioning/state/route.ts
 *
 * Two independent defects lived here, and each hid the other:
 *
 *  1. NO SCOPE. The handler ignored ?subsystemId and returned every MCM's VFD
 *     rows, so /commissioning/16 rendered belts belonging to MCM02, MCM04, …
 *
 *  2. COLLAPSING PIVOT. Rows were accumulated under `deviceName::sheetName`.
 *     L2 sheets are project-global templates shared by every MCM, so MCM02's
 *     BYCB_1_VFD and MCM04's BYCB_1_VFD hit the SAME key: whichever row was
 *     read first won, and the other machine's cells were silently dropped.
 *     A belt genuinely BLOCKED on one MCM therefore reported "ready" — the
 *     MCM15 divergence class the cloud blocker mirror was built to prevent,
 *     reintroduced one layer above the mirror. On the real CDW5 database this
 *     turned 392 devices into 320 records: 72 belts' state discarded.
 *
 * Both are pinned below.
 */

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE L2Sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT NOT NULL, DisplayName TEXT, DisplayOrder INTEGER
    );
    CREATE TABLE L2Columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, SheetId INTEGER NOT NULL, Name TEXT NOT NULL,
      ColumnType TEXT, DisplayOrder INTEGER
    );
    CREATE TABLE L2Devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, SheetId INTEGER NOT NULL,
      DeviceName TEXT NOT NULL, Mcm TEXT, Subsystem TEXT, DisplayOrder INTEGER
    );
    CREATE TABLE L2CellValues (
      id INTEGER PRIMARY KEY AUTOINCREMENT, DeviceId INTEGER NOT NULL, ColumnId INTEGER NOT NULL,
      Value TEXT, UpdatedBy TEXT, UpdatedAt TEXT, Version INTEGER DEFAULT 1
    );
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY, Name TEXT);
    CREATE TABLE VfdControlsVerified (
      SubsystemId INTEGER NOT NULL DEFAULT 0, deviceName TEXT NOT NULL,
      completedBy TEXT, completedAt TEXT, PRIMARY KEY (SubsystemId, deviceName)
    );
    CREATE TABLE VfdBlocker (
      SubsystemId INTEGER NOT NULL, DeviceName TEXT NOT NULL, Party TEXT, Description TEXT,
      UpdatedBy TEXT, UpdatedAt TEXT, AddressedBy TEXT, AddressedAt TEXT,
      PRIMARY KEY (SubsystemId, DeviceName)
    );
    CREATE TABLE VfdAddressed (
      SubsystemId INTEGER NOT NULL, DeviceName TEXT NOT NULL, Addressed INTEGER,
      AddressedBy TEXT, AddressedAt TEXT, PRIMARY KEY (SubsystemId, DeviceName)
    );
    CREATE TABLE DeviceBlockerPendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER, DeviceName TEXT, Op TEXT,
      RetryCount INTEGER DEFAULT 0, DeadLettered INTEGER DEFAULT 0
    );
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))

// Static import is safe: vi.mock is hoisted above it, so the route binds the
// in-memory DB. (A top-level `await import` trips the project's TS module target.)
import { GET } from '@/app/api/vfd-commissioning/state/route'

/** Minimal express-ish res capturing the JSON body. */
function mockRes() {
  const out: { code: number; body: any } = { code: 200, body: null }
  const res: any = {
    status(c: number) { out.code = c; return res },
    json(b: any) { out.body = b; return res },
  }
  return { res, out }
}

const call = async (subsystemId?: number) => {
  const { res, out } = mockRes()
  await GET({ query: subsystemId == null ? {} : { subsystemId: String(subsystemId) } } as any, res)
  return out.body?.states ?? []
}

const MCM02 = 38
const MCM04 = 40
const SHARED_NAME = 'BYCB_1_VFD'

beforeEach(() => {
  memDb.exec('DELETE FROM L2Devices; DELETE FROM L2CellValues; DELETE FROM L2Sheets; DELETE FROM L2Columns; DELETE FROM Subsystems; DELETE FROM VfdBlocker; DELETE FROM VfdAddressed; DELETE FROM VfdControlsVerified; DELETE FROM DeviceBlockerPendingSyncs;')

  // ONE project-global APF sheet, shared by both MCMs — this is what makes the
  // name+sheet pivot key collide.
  memDb.prepare("INSERT INTO L2Sheets (id, Name, DisplayName, DisplayOrder) VALUES (1,'APF','APF',1)").run()
  memDb.prepare("INSERT INTO L2Columns (id, SheetId, Name, ColumnType, DisplayOrder) VALUES (1,1,'Bump Blocker','text',1)").run()
  memDb.prepare("INSERT INTO L2Columns (id, SheetId, Name, ColumnType, DisplayOrder) VALUES (2,1,'Verify Identity','text',2)").run()
  memDb.prepare("INSERT INTO Subsystems (id, Name) VALUES (?, 'MCM02'), (?, 'MCM04')").run(MCM02, MCM04)

  // The SAME belt name on two different machines.
  memDb.prepare("INSERT INTO L2Devices (id, SubsystemId, SheetId, DeviceName, Mcm, Subsystem, DisplayOrder) VALUES (10,?,1,?, 'MCM02','MCM02',1)").run(MCM02, SHARED_NAME)
  memDb.prepare("INSERT INTO L2Devices (id, SubsystemId, SheetId, DeviceName, Mcm, Subsystem, DisplayOrder) VALUES (20,?,1,?, 'MCM04','MCM04',2)").run(MCM04, SHARED_NAME)
})

describe('GET /api/vfd-commissioning/state — per-MCM', () => {
  it('scopes to the requested MCM only', async () => {
    const states = await call(MCM04)
    expect(states).toHaveLength(1)
    expect(states[0].subsystemId).toBe(MCM04)
    expect(states[0].mcm).toBe('MCM04')
  })

  it('does NOT collapse same-named belts from different MCMs', async () => {
    // Unscoped, both machines must still surface as SEPARATE records.
    const states = await call()
    expect(states).toHaveLength(2)
    expect(new Set(states.map((s: any) => s.subsystemId))).toEqual(new Set([MCM02, MCM04]))
  })

  it("one MCM's blocker does not mark the other MCM's same-named belt blocked", async () => {
    // MCM02's belt is blocked via its own Bump Blocker cell. MCM04's is clean.
    memDb.prepare("INSERT INTO L2CellValues (DeviceId, ColumnId, Value, Version) VALUES (10, 1, 'ASH 9/5 · Mechanical · belt slipping', 1)").run()

    const mcm02 = (await call(MCM02))[0]
    const mcm04 = (await call(MCM04))[0]

    expect(mcm02.blocked).toBe(true)
    expect(mcm02.blockerParty).toBe('Mechanical')
    expect(mcm04.blocked).toBe(false)
  })

  it("a cloud blocker on one MCM does not leak onto the other (mirror key)", async () => {
    memDb.prepare("INSERT INTO VfdBlocker (SubsystemId, DeviceName, Party, Description, UpdatedBy, UpdatedAt) VALUES (?,?,'Mechanical','raised on another box','SL','2026-07-20')").run(MCM02, SHARED_NAME)

    expect((await call(MCM02))[0].blocked).toBe(true)
    expect((await call(MCM04))[0].blocked).toBe(false)
  })

  it('controls-verified is reported for the verified MCM only', async () => {
    memDb.prepare("INSERT INTO VfdControlsVerified (SubsystemId, deviceName, completedBy) VALUES (?,?,'ASH')").run(MCM02, SHARED_NAME)

    expect((await call(MCM02))[0].cells.controlsVerified).toBe('ASH')
    // The safety regression: this used to inherit MCM02's stamp.
    expect((await call(MCM04))[0].cells.controlsVerified).toBeNull()
  })

  it("keeps each MCM's own cell values instead of dropping the loser's", async () => {
    memDb.prepare("INSERT INTO L2CellValues (DeviceId, ColumnId, Value, Version) VALUES (10, 2, 'ASH 9/5', 1)").run()
    memDb.prepare("INSERT INTO L2CellValues (DeviceId, ColumnId, Value, Version) VALUES (20, 2, 'SL 9/9', 1)").run()

    expect((await call(MCM02))[0].cells.verifyIdentity).toBe('ASH 9/5')
    expect((await call(MCM04))[0].cells.verifyIdentity).toBe('SL 9/9')
  })
})
