/**
 * SERVER-SIDE BELT-TRACKING GATE on the VFD tag-write routes.
 *
 * INCIDENT (2026-07-22, MCM15). The wizard's polarity step calls
 * pulseValidationChain(['Valid_Map','Valid_HP','Tracking_Finished',
 * 'Valid_Direction']) -> POST /api/vfd-commissioning/write-tag. That route
 * validated presence and type only: no field allowlist, no Belt Tracked
 * lookup. Any client could latch CMD.Tracking_Finished on any device by name,
 * and AOI rung 3 holds that latch — while it is set the tool owns polarity and
 * the mechanics' keypad cannot change belt direction. Four hours of mechanics'
 * time were lost, and a coordinator "helping" by inverting belts through the
 * tool re-locked four more.
 *
 * 9d9a826 made the wizard fall back when the cell clears. That is a UI flag,
 * and a UI flag is not a guard — it constrains exactly one client. These tests
 * pin the SERVER-SIDE refusal, which runs on the box holding the PLC
 * connection, before any tag path is built.
 *
 * Ladder ground truth (AOI_IOCT_BELT_TRACKING_AOI222.L5X — do NOT re-derive
 * from comments in this repo, several are wrong):
 *   rung 1  Valid_Map / Valid_HP latch + their Invalidates
 *   rungs 2,3,4,5  ALL gated XIC(Valid_HP) -> Valid_HP=1 is the master enable
 *                  for every operator keypad function
 *   rung 3  holds Tracking_Finished
 *   rung 6  OTL(Valid_Direction) requires Tracking_Finished; gates Run_At_30_RVS
 *   rung 7  UNCONDITIONAL Reverse_Polarity -> DirectionCmd
 *   rung 8  FLL(0, CTRL.CMD, 1) — every CMD write is a self-clearing pulse
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  // Faithful mirror of the production L2 schema (lib/db-sqlite.ts).
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
// Import the real constant rather than stubbing a literal — the point of
// sourcing the column name from the writer is that they cannot drift.
vi.mock('@/lib/vfd-validation-writer', () => ({
  BELT_TRACKED_COLUMN_NAME: 'Belt Tracked',
  BELT_TRACKED_VALUE: 'Yes',
}))

// ── PLC seam. Both write branches are recorded, never executed. ────────────
const plcCalls = vi.hoisted(() => ({
  mcm: [] as Array<{ sid: string; tags: Array<{ name: string; value: number }> }>,
  singleton: [] as Array<{ tagPath: string; value: number }>,
  hammer: [] as Array<{ deviceName: string; fields: string[] }>,
  hammerMcm: [] as Array<{ sid: string; deviceName: string; fields: string[] }>,
  registeredMcms: new Set<string>(),
}))

vi.mock('@/lib/mcm-registry', () => ({
  hasMcm: (sid: string) => plcCalls.registeredMcms.has(String(sid)),
  // No embedded client in this suite — the batch route then dispatches through
  // hammerWriteTagsForMcm (the gateway/registry RPC facade recorded below).
  getEmbeddedMcmConnection: () => null,
  writeTypedTagsForMcm: async (sid: string, tags: Array<{ name: string; value: number }>) => {
    plcCalls.mcm.push({ sid, tags })
    return { connected: true, results: tags.map(() => ({ success: true })) }
  },
  hammerWriteTagsForMcm: async (
    sid: string, deviceName: string, writes: Array<{ field: string }>,
  ) => {
    plcCalls.hammerMcm.push({ sid, deviceName, fields: writes.map(w => w.field) })
    return { connected: true, success: true, iterations: 50, writes: [] }
  },
}))

vi.mock('@/lib/plc-client-manager', () => ({
  getPlcClient: () => ({
    isConnected: true,
    // The routes now AWAIT these (async FFI conversion); returning plain
    // objects still works — await on a non-promise resolves immediately.
    writeTypedTag: (tagPath: string, value: number) => {
      plcCalls.singleton.push({ tagPath, value })
      return { success: true }
    },
    hammerWriteTagsAsync: (deviceName: string, writes: Array<{ field: string }>) => {
      plcCalls.hammer.push({ deviceName, fields: writes.map(w => w.field) })
      return { success: true, iterations: 50, writes: [] }
    },
  }),
}))

import {
  judgeWrite,
  judgeBatch,
  isPostGateField,
  POST_GATE_CMD_FIELDS,
  POST_GATE_HMI_FIELDS,
  ALWAYS_ALLOWED_FIELDS,
  type BeltTrackedState,
} from '@/app/api/vfd-commissioning/_gate/belt-tracking-gate'
import { lookupBeltTrackedState } from '@/app/api/vfd-commissioning/_gate/belt-tracked-lookup'
import { POST as writeTagPOST } from '@/app/api/vfd-commissioning/write-tag/route'
import { POST as writeBatchPOST } from '@/app/api/vfd-commissioning/write-tags-batch/route'

// ── Fixtures ──────────────────────────────────────────────────────────────

/** Every field the gate must REFUSE on an untracked belt. */
const POST_GATE_FIELDS = [...POST_GATE_CMD_FIELDS, ...POST_GATE_HMI_FIELDS]

/** Fields that must ALWAYS get through — pre-gate work and identity/HP. */
const PRE_GATE_FIELDS = ['Valid_Map', 'Valid_HP', 'Speed_FPM']

const TRACKED: BeltTrackedState = { resolved: true, hasColumn: true, tracked: true }
const UNTRACKED: BeltTrackedState = { resolved: true, hasColumn: true, tracked: false }
const NO_COLUMN: BeltTrackedState = { resolved: true, hasColumn: false }
const NOT_IN_L2: BeltTrackedState = { resolved: false }
const LOOKUP_BROKEN: BeltTrackedState = { resolved: false, error: 'belt-tracking lookup failed' }

let sheetSeq = 0
/**
 * Seed one device.
 *  - `beltTracked: undefined` → the sheet HAS the column, cell empty (untracked)
 *  - `beltTracked: null`      → the sheet has NO 'Belt Tracked' column at all
 */
function seedDevice(opts: {
  deviceName: string
  subsystemId?: number | null
  subsystem?: string | null
  beltTracked?: string | null
  sheetName?: string
}) {
  const sheetName = opts.sheetName ?? `VFD Sheet ${++sheetSeq}`
  memDb.prepare('INSERT INTO L2Sheets (Name) VALUES (?)').run(sheetName)
  const sheetId = Number(memDb.prepare('SELECT last_insert_rowid() AS id').get().id)
  memDb.prepare(
    'INSERT INTO L2Devices (SheetId, DeviceName, Subsystem, SubsystemId) VALUES (?, ?, ?, ?)',
  ).run(sheetId, opts.deviceName, opts.subsystem ?? null, opts.subsystemId ?? null)
  const deviceId = Number(memDb.prepare('SELECT last_insert_rowid() AS id').get().id)

  // A sibling column always exists, so "no Belt Tracked column" is not the
  // same as "no columns" — the LEFT JOIN has to distinguish them.
  memDb.prepare('INSERT INTO L2Columns (SheetId, Name) VALUES (?, ?)').run(sheetId, 'Verify Identity')

  if (opts.beltTracked !== null) {
    memDb.prepare('INSERT INTO L2Columns (SheetId, Name) VALUES (?, ?)').run(sheetId, 'Belt Tracked')
    const colId = Number(memDb.prepare('SELECT last_insert_rowid() AS id').get().id)
    if (opts.beltTracked !== undefined) {
      memDb.prepare(
        'INSERT INTO L2CellValues (DeviceId, ColumnId, Value) VALUES (?, ?, ?)',
      ).run(deviceId, colId, opts.beltTracked)
    }
  }
  return { sheetId, deviceId, sheetName }
}

/** Minimal express req/res doubles. */
function mkRes() {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  return { res, out }
}
const mkReq = (body: any): any => ({ body })

beforeEach(() => {
  memDb.exec('DELETE FROM L2CellValues; DELETE FROM L2Columns; DELETE FROM L2Devices; DELETE FROM L2Sheets; DELETE FROM Subsystems;')
  plcCalls.mcm.length = 0
  plcCalls.singleton.length = 0
  plcCalls.hammer.length = 0
  plcCalls.hammerMcm.length = 0
  plcCalls.registeredMcms.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

// ── 1. The field lists ────────────────────────────────────────────────────

describe('post-gate field list', () => {
  it('covers every write that can take belt direction from the keypad', () => {
    expect(POST_GATE_CMD_FIELDS).toEqual([
      'Tracking_Finished',   // rung 3 — THE latch
      'Valid_Direction',     // rung 6 — behind the latch, gates Run_At_30_RVS
      'Bump',                // commands motion from the tool
      'Run_At_30_RVS',       // commands motion from the tool
      'Reverse_Polarity',    // rung 7 maps polarity onto DirectionCmd
      'Normal_Polarity',
    ])
    expect(POST_GATE_HMI_FIELDS).toEqual(['Speed_At_30rev'])
  })

  it('never gates the master keypad enable — Valid_Map / Valid_HP stay open', () => {
    // Gating these would drop Valid_HP, and rungs 2/3/4/5 are ALL gated on it.
    // That is the very failure this gate exists to prevent.
    for (const f of PRE_GATE_FIELDS) expect(isPostGateField(f)).toBe(false)
  })

  it('never gates the retraction fields — they can only UNLATCH', () => {
    expect(ALWAYS_ALLOWED_FIELDS).toEqual([
      'Invalidate_Tracking_Finished',
      'Invalidate_Direction',
    ])
    for (const f of ALWAYS_ALLOWED_FIELDS) expect(isPostGateField(f)).toBe(false)
    // The rung-1 invalidates are ungated too (absent from the deny-set).
    for (const f of ['Invalidate_Map', 'Invalidate_HP']) expect(isPostGateField(f)).toBe(false)
  })

  it('never names the dead tag Stop_Belt_Tracking (0 of 11 rungs use it)', () => {
    expect([...POST_GATE_FIELDS, ...ALWAYS_ALLOWED_FIELDS]).not.toContain('Stop_Belt_Tracking')
  })
})

// ── 2. The pure decision ──────────────────────────────────────────────────

describe('judgeWrite', () => {
  it('REFUSES every post-gate field on an untracked belt', () => {
    for (const field of POST_GATE_FIELDS) {
      const d = judgeWrite(field, UNTRACKED)
      expect(d.allowed, `${field} must be refused`).toBe(false)
      expect(d.code).toBe('belt_not_tracked')
      // Machine-readable AND operator-readable, so the caller can show
      // something better than a generic failure.
      expect(d.message).toMatch(/Belt Tracked/)
      expect(d.message).toMatch(/mechanical team/i)
      expect(d.field).toBe(field)
    }
  })

  it('ALLOWS every post-gate field once the belt is tracked', () => {
    for (const field of POST_GATE_FIELDS) {
      const d = judgeWrite(field, TRACKED)
      expect(d.allowed, `${field} must be allowed`).toBe(true)
      expect(d.code).toBe('belt_tracked')
    }
  })

  it('ALLOWS pre-gate fields in every belt state', () => {
    for (const state of [TRACKED, UNTRACKED, NO_COLUMN, NOT_IN_L2, LOOKUP_BROKEN]) {
      for (const field of PRE_GATE_FIELDS) {
        expect(judgeWrite(field, state).allowed, field).toBe(true)
      }
    }
  })

  it('ALLOWS retraction fields in every belt state — an untracked belt with a stale latch is exactly when they are needed', () => {
    for (const state of [TRACKED, UNTRACKED, NO_COLUMN, NOT_IN_L2, LOOKUP_BROKEN]) {
      for (const field of ALWAYS_ALLOWED_FIELDS) {
        const d = judgeWrite(field, state)
        expect(d.allowed, field).toBe(true)
        expect(d.code).toBe('retraction_field')
      }
    }
  })

  it('NEVER gates a device whose sheet has no Belt Tracked column', () => {
    // Not every template has belt tracking. Gating those breaks other sheets.
    for (const field of POST_GATE_FIELDS) {
      const d = judgeWrite(field, NO_COLUMN)
      expect(d.allowed, field).toBe(true)
      expect(d.code).toBe('no_belt_tracking_column')
    }
  })

  it('does not gate a device with no L2 row — nothing to judge, not evidence of anything', () => {
    for (const field of POST_GATE_FIELDS) {
      const d = judgeWrite(field, NOT_IN_L2)
      expect(d.allowed, field).toBe(true)
      expect(d.code).toBe('device_not_in_l2')
    }
  })

  it('FAILS CLOSED when the lookup itself broke — we cannot prove the belt is tracked', () => {
    for (const field of POST_GATE_FIELDS) {
      const d = judgeWrite(field, LOOKUP_BROKEN)
      expect(d.allowed, field).toBe(false)
      expect(d.code).toBe('gate_unavailable')
    }
  })

  it('matches case-insensitively — Logix tag names are, so a case-sensitive deny-set is a one-keystroke bypass', () => {
    for (const v of ['tracking_finished', 'TRACKING_FINISHED', '  Tracking_Finished  ']) {
      expect(judgeWrite(v, UNTRACKED).allowed, v).toBe(false)
    }
    expect(judgeWrite('invalidate_tracking_finished', UNTRACKED).allowed).toBe(true)
  })
})

describe('judgeBatch', () => {
  it('refuses the WHOLE batch on the first post-gate field — half a pair is not safer than none', () => {
    const d = judgeBatch(['Reverse_Polarity', 'Normal_Polarity'], UNTRACKED)
    expect(d?.allowed).toBe(false)
    expect(d?.field).toBe('Reverse_Polarity')
  })

  it('refuses a mixed batch that hides a post-gate field behind a pre-gate one', () => {
    expect(judgeBatch(['Valid_Map', 'Tracking_Finished'], UNTRACKED)?.code).toBe('belt_not_tracked')
  })

  it('passes a batch of pre-gate fields, and any batch once tracked', () => {
    expect(judgeBatch(['Valid_Map', 'Valid_HP'], UNTRACKED)).toBeNull()
    expect(judgeBatch(['Reverse_Polarity', 'Normal_Polarity'], TRACKED)).toBeNull()
  })
})

// ── 3. Resolving tracked state from the local L2 cell ─────────────────────

describe('lookupBeltTrackedState', () => {
  it('reads an empty cell as untracked and a filled one as tracked', () => {
    seedDevice({ deviceName: 'CV0010', subsystemId: 15, beltTracked: undefined })
    seedDevice({ deviceName: 'CV0020', subsystemId: 15, beltTracked: 'ASH 7/22' })
    expect(lookupBeltTrackedState('CV0010', 15)).toEqual({ resolved: true, hasColumn: true, tracked: false })
    expect(lookupBeltTrackedState('CV0020', 15)).toEqual({ resolved: true, hasColumn: true, tracked: true })
  })

  it('treats a whitespace-only cell as untracked', () => {
    seedDevice({ deviceName: 'CV0030', subsystemId: 15, beltTracked: '   ' })
    expect(lookupBeltTrackedState('CV0030', 15)).toMatchObject({ tracked: false })
  })

  it('accepts the writer\'s "Yes" as tracked too — this is looser than the writer, never tighter', () => {
    seedDevice({ deviceName: 'CV0040', subsystemId: 15, beltTracked: 'Yes' })
    expect(lookupBeltTrackedState('CV0040', 15)).toMatchObject({ tracked: true })
  })

  it('reports hasColumn:false for a sheet without the column, distinct from an empty cell', () => {
    seedDevice({ deviceName: 'CV0050', subsystemId: 15, beltTracked: null })
    expect(lookupBeltTrackedState('CV0050', 15)).toEqual({ resolved: true, hasColumn: false })
  })

  it('reports unresolved for a device with no L2 row at all', () => {
    expect(lookupBeltTrackedState('NOPE', 15)).toEqual({ resolved: false })
  })

  it('ignores non-VFD/APF sheets — the canonical sheet filter', () => {
    seedDevice({ deviceName: 'CV0060', subsystemId: 15, beltTracked: undefined, sheetName: 'Photoeyes' })
    expect(lookupBeltTrackedState('CV0060', 15)).toEqual({ resolved: false })
  })

  it('matches the device name case-insensitively, like the clear route', () => {
    seedDevice({ deviceName: 'CV0070', subsystemId: 15, beltTracked: undefined })
    expect(lookupBeltTrackedState('cv0070', 15)).toMatchObject({ hasColumn: true, tracked: false })
  })

  it('SCOPES to the caller\'s MCM — belt names repeat, and the wrong row judges the wrong belt', () => {
    seedDevice({ deviceName: 'CV0100', subsystemId: 14, beltTracked: 'ASH 7/22' }) // tracked on 14
    seedDevice({ deviceName: 'CV0100', subsystemId: 15, beltTracked: undefined })  // NOT on 15
    expect(lookupBeltTrackedState('CV0100', 14)).toMatchObject({ tracked: true })
    expect(lookupBeltTrackedState('CV0100', 15)).toMatchObject({ tracked: false })
  })

  it('falls back to the name-matched Subsystems row for legacy unstamped devices', () => {
    memDb.prepare('INSERT INTO Subsystems (id, Name) VALUES (?, ?)').run(15, 'MCM15')
    seedDevice({ deviceName: 'CV0110', subsystemId: null, subsystem: 'MCM15', beltTracked: undefined })
    expect(lookupBeltTrackedState('CV0110', 15)).toMatchObject({ hasColumn: true, tracked: false })
  })

  it('unscoped: an untracked row anywhere makes it untracked — an unscoped caller cannot prove which belt it is moving', () => {
    seedDevice({ deviceName: 'CV0200', subsystemId: 14, beltTracked: 'ASH 7/22' })
    seedDevice({ deviceName: 'CV0200', subsystemId: 15, beltTracked: undefined })
    expect(lookupBeltTrackedState('CV0200')).toMatchObject({ tracked: false })
  })

  it('unscoped single-MCM (the legacy tablet) is unaffected', () => {
    seedDevice({ deviceName: 'CV0210', subsystemId: 15, beltTracked: 'ASH 7/22' })
    expect(lookupBeltTrackedState('CV0210')).toMatchObject({ tracked: true })
  })
})

// ── 4. The routes — BOTH branches ─────────────────────────────────────────

describe('POST /write-tag — legacy singleton branch', () => {
  it('REFUSES Tracking_Finished on an untracked belt and writes NOTHING to the PLC', async () => {
    seedDevice({ deviceName: 'CV0010', subsystemId: 15, beltTracked: undefined })
    const { res, out } = mkRes()
    // No registry entry for 15 → falls through to the singleton (the /api/ios
    // convention a legacy single-PLC tablet relies on).
    await writeTagPOST(mkReq({
      deviceName: 'CV0010', field: 'Tracking_Finished', value: 1, dataType: 'BOOL', subsystemId: 15,
    }), res)
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('belt_not_tracked')
    expect(out.body.error).toBeTruthy()      // legacy clients read res.ok + .error
    expect(out.body.message).toMatch(/mechanical team/i)
    expect(plcCalls.singleton).toEqual([])
    expect(plcCalls.mcm).toEqual([])
  })

  it('ALLOWS Tracking_Finished once the belt is tracked', async () => {
    seedDevice({ deviceName: 'CV0020', subsystemId: 15, beltTracked: 'ASH 7/22' })
    const { res, out } = mkRes()
    await writeTagPOST(mkReq({
      deviceName: 'CV0020', field: 'Tracking_Finished', value: 1, dataType: 'BOOL', subsystemId: 15,
    }), res)
    expect(out.status).toBe(200)
    expect(out.body.success).toBe(true)
    expect(plcCalls.singleton).toEqual([{ tagPath: 'CBT_CV0020.CTRL.CMD.Tracking_Finished', value: 1 }])
  })

  it('ALLOWS Valid_Map / Valid_HP on an untracked belt — the keypad must never be lost to this gate', async () => {
    seedDevice({ deviceName: 'CV0030', subsystemId: 15, beltTracked: undefined })
    for (const field of ['Valid_Map', 'Valid_HP']) {
      const { res, out } = mkRes()
      await writeTagPOST(mkReq({
        deviceName: 'CV0030', field, value: 1, dataType: 'BOOL', subsystemId: 15,
      }), res)
      expect(out.status, field).toBe(200)
    }
    expect(plcCalls.singleton.map(c => c.tagPath)).toEqual([
      'CBT_CV0030.CTRL.CMD.Valid_Map', 'CBT_CV0030.CTRL.CMD.Valid_HP',
    ])
  })

  it('ALLOWS the retraction fields on an untracked belt', async () => {
    seedDevice({ deviceName: 'CV0040', subsystemId: 15, beltTracked: undefined })
    for (const field of ALWAYS_ALLOWED_FIELDS) {
      const { res, out } = mkRes()
      await writeTagPOST(mkReq({
        deviceName: 'CV0040', field, value: 1, dataType: 'BOOL', subsystemId: 15,
      }), res)
      expect(out.status, field).toBe(200)
    }
    expect(plcCalls.singleton).toHaveLength(ALWAYS_ALLOWED_FIELDS.length)
  })

  it('REFUSES the HMI speed write on an untracked belt (pathScope=HMI)', async () => {
    seedDevice({ deviceName: 'CV0050', subsystemId: 15, beltTracked: undefined })
    const { res, out } = mkRes()
    await writeTagPOST(mkReq({
      deviceName: 'CV0050', field: 'Speed_At_30rev', value: 25, dataType: 'DINT',
      pathScope: 'HMI', subsystemId: 15,
    }), res)
    expect(out.status).toBe(409)
    expect(plcCalls.singleton).toEqual([])
  })

  it('REFUSES a post-gate field written as 0 too — value is not a bypass', async () => {
    // The wizard sends Bump=0 then Bump=1 to re-arm rung 7's ONS. A CMD bit at
    // 0 is a no-op anyway (rung 8 FLLs CMD every scan), so refusing costs
    // nothing and closes a value-based bypass.
    seedDevice({ deviceName: 'CV0060', subsystemId: 15, beltTracked: undefined })
    const { res, out } = mkRes()
    await writeTagPOST(mkReq({
      deviceName: 'CV0060', field: 'Bump', value: 0, dataType: 'BOOL', subsystemId: 15,
    }), res)
    expect(out.status).toBe(409)
    expect(plcCalls.singleton).toEqual([])
  })

  it('NEVER gates a device whose sheet has no Belt Tracked column', async () => {
    seedDevice({ deviceName: 'CV0070', subsystemId: 15, beltTracked: null })
    for (const field of POST_GATE_FIELDS) {
      const { res, out } = mkRes()
      await writeTagPOST(mkReq({
        deviceName: 'CV0070', field, value: 1, dataType: 'BOOL', subsystemId: 15,
      }), res)
      expect(out.status, field).toBe(200)
    }
    expect(plcCalls.singleton).toHaveLength(POST_GATE_FIELDS.length)
  })
})

describe('POST /write-tag — MCM-routed branch', () => {
  beforeEach(() => { plcCalls.registeredMcms.add('15') })

  it('REFUSES Tracking_Finished on an untracked belt and never reaches the gateway', async () => {
    seedDevice({ deviceName: 'CV0010', subsystemId: 15, beltTracked: undefined })
    const { res, out } = mkRes()
    await writeTagPOST(mkReq({
      deviceName: 'CV0010', field: 'Tracking_Finished', value: 1, dataType: 'BOOL', subsystemId: 15,
    }), res)
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('belt_not_tracked')
    expect(plcCalls.mcm).toEqual([])
    expect(plcCalls.singleton).toEqual([])
  })

  it('ALLOWS Tracking_Finished once tracked, routed to the owning controller', async () => {
    seedDevice({ deviceName: 'CV0020', subsystemId: 15, beltTracked: 'ASH 7/22' })
    const { res, out } = mkRes()
    await writeTagPOST(mkReq({
      deviceName: 'CV0020', field: 'Tracking_Finished', value: 1, dataType: 'BOOL', subsystemId: 15,
    }), res)
    expect(out.status).toBe(200)
    expect(plcCalls.mcm).toHaveLength(1)
    expect(plcCalls.mcm[0].sid).toBe('15')
    expect(plcCalls.mcm[0].tags[0].name).toBe('CBT_CV0020.CTRL.CMD.Tracking_Finished')
  })

  it('judges the belt on the CALLER\'S MCM, not a same-named belt on another', async () => {
    plcCalls.registeredMcms.add('14')
    seedDevice({ deviceName: 'CV0100', subsystemId: 14, beltTracked: 'ASH 7/22' })
    seedDevice({ deviceName: 'CV0100', subsystemId: 15, beltTracked: undefined })

    const a = mkRes()
    await writeTagPOST(mkReq({
      deviceName: 'CV0100', field: 'Tracking_Finished', value: 1, dataType: 'BOOL', subsystemId: 14,
    }), a.res)
    expect(a.out.status).toBe(200)

    const b = mkRes()
    await writeTagPOST(mkReq({
      deviceName: 'CV0100', field: 'Tracking_Finished', value: 1, dataType: 'BOOL', subsystemId: 15,
    }), b.res)
    expect(b.out.status).toBe(409)
    expect(plcCalls.mcm.map(c => c.sid)).toEqual(['14'])
  })

  it('ALLOWS pre-gate and retraction fields on an untracked belt', async () => {
    seedDevice({ deviceName: 'CV0030', subsystemId: 15, beltTracked: undefined })
    for (const field of [...PRE_GATE_FIELDS.filter(f => f !== 'Speed_FPM'), ...ALWAYS_ALLOWED_FIELDS]) {
      const { res, out } = mkRes()
      await writeTagPOST(mkReq({
        deviceName: 'CV0030', field, value: 1, dataType: 'BOOL', subsystemId: 15,
      }), res)
      expect(out.status, field).toBe(200)
    }
    expect(plcCalls.mcm).toHaveLength(4)
  })
})

describe('POST /write-tags-batch — both branches', () => {
  const polarityPair = [
    { field: 'Reverse_Polarity', value: 1, dataType: 'BOOL' as const },
    { field: 'Normal_Polarity', value: 0, dataType: 'BOOL' as const },
  ]

  it('singleton: REFUSES the polarity pair on an untracked belt — the batch a coordinator re-locked four belts with', async () => {
    seedDevice({ deviceName: 'CV0010', subsystemId: 15, beltTracked: undefined })
    const { res, out } = mkRes()
    await writeBatchPOST(mkReq({ deviceName: 'CV0010', writes: polarityPair, subsystemId: 15 }), res)
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('belt_not_tracked')
    expect(out.body.field).toBe('Reverse_Polarity')
    // The hammer loop re-writes for ~1s: an ungated field here is 50-100
    // chances to latch, not one.
    expect(plcCalls.hammer).toEqual([])
    expect(plcCalls.hammerMcm).toEqual([])
  })

  it('singleton: ALLOWS the polarity pair once tracked', async () => {
    seedDevice({ deviceName: 'CV0020', subsystemId: 15, beltTracked: 'ASH 7/22' })
    const { res, out } = mkRes()
    await writeBatchPOST(mkReq({ deviceName: 'CV0020', writes: polarityPair, subsystemId: 15 }), res)
    expect(out.status).toBe(200)
    expect(plcCalls.hammer).toEqual([
      { deviceName: 'CV0020', fields: ['Reverse_Polarity', 'Normal_Polarity'] },
    ])
  })

  it('MCM: REFUSES the polarity pair on an untracked belt and never reaches the gateway', async () => {
    plcCalls.registeredMcms.add('15')
    seedDevice({ deviceName: 'CV0030', subsystemId: 15, beltTracked: undefined })
    const { res, out } = mkRes()
    await writeBatchPOST(mkReq({ deviceName: 'CV0030', writes: polarityPair, subsystemId: 15 }), res)
    expect(out.status).toBe(409)
    expect(plcCalls.hammerMcm).toEqual([])
  })

  it('MCM: ALLOWS the polarity pair once tracked', async () => {
    plcCalls.registeredMcms.add('15')
    seedDevice({ deviceName: 'CV0040', subsystemId: 15, beltTracked: 'ASH 7/22' })
    const { res, out } = mkRes()
    await writeBatchPOST(mkReq({ deviceName: 'CV0040', writes: polarityPair, subsystemId: 15 }), res)
    expect(out.status).toBe(200)
    expect(plcCalls.hammerMcm).toEqual([
      { sid: '15', deviceName: 'CV0040', fields: ['Reverse_Polarity', 'Normal_Polarity'] },
    ])
  })

  it('a batch of retraction fields always gets through, on an untracked belt', async () => {
    seedDevice({ deviceName: 'CV0050', subsystemId: 15, beltTracked: undefined })
    const { res, out } = mkRes()
    await writeBatchPOST(mkReq({
      deviceName: 'CV0050',
      writes: ALWAYS_ALLOWED_FIELDS.map(field => ({ field, value: 1, dataType: 'BOOL' as const })),
      subsystemId: 15,
    }), res)
    expect(out.status).toBe(200)
    expect(plcCalls.hammer).toHaveLength(1)
  })

  it('NEVER gates a batch on a sheet without the Belt Tracked column', async () => {
    seedDevice({ deviceName: 'CV0060', subsystemId: 15, beltTracked: null })
    const { res, out } = mkRes()
    await writeBatchPOST(mkReq({ deviceName: 'CV0060', writes: polarityPair, subsystemId: 15 }), res)
    expect(out.status).toBe(200)
    expect(plcCalls.hammer).toHaveLength(1)
  })
})

// ── 5. The incident, end to end ───────────────────────────────────────────

describe('THE INCIDENT: pulseValidationChain against an untracked belt', () => {
  it('lets Valid_Map and Valid_HP through but refuses Tracking_Finished and Valid_Direction', async () => {
    seedDevice({ deviceName: 'CV0010', subsystemId: 15, beltTracked: undefined })
    const chain = ['Valid_Map', 'Valid_HP', 'Tracking_Finished', 'Valid_Direction']
    const statuses: number[] = []
    for (const field of chain) {
      const { res, out } = mkRes()
      await writeTagPOST(mkReq({
        deviceName: 'CV0010', field, value: 1, dataType: 'BOOL', subsystemId: 15,
      }), res)
      statuses.push(out.status)
    }
    // Pre-gate through (the mechanic keeps the keypad), post-gate refused.
    expect(statuses).toEqual([200, 200, 409, 409])
    expect(plcCalls.singleton.map(c => c.tagPath)).toEqual([
      'CBT_CV0010.CTRL.CMD.Valid_Map',
      'CBT_CV0010.CTRL.CMD.Valid_HP',
    ])
  })

  it('and the same chain sails through once the mechanical team marks the belt tracked', async () => {
    seedDevice({ deviceName: 'CV0020', subsystemId: 15, beltTracked: 'ASH 7/22' })
    for (const field of ['Valid_Map', 'Valid_HP', 'Tracking_Finished', 'Valid_Direction']) {
      const { res, out } = mkRes()
      await writeTagPOST(mkReq({
        deviceName: 'CV0020', field, value: 1, dataType: 'BOOL', subsystemId: 15,
      }), res)
      expect(out.status, field).toBe(200)
    }
    expect(plcCalls.singleton).toHaveLength(4)
  })
})
