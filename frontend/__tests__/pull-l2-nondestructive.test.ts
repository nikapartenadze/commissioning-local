import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Data-safety invariants of the NON-DESTRUCTIVE FV/L2 pull.
 *
 * FILE UNDER TEST: app/api/cloud/pull-l2/route.ts (POST).
 *
 * The pull used to DELETE this subsystem's L2 devices + cells and reinsert only
 * the cloud payload — which silently WIPED operator-entered FV cells the cloud
 * endpoint did not (yet) serve (the "FV entered then gone" incident). The
 * rewrite makes it an UPSERT: sheets/columns/devices matched by CloudId and
 * updated in place, cells merged last-write-wins by (DeviceId,ColumnId), never
 * blanked, never deleted. Genuine cloud deletions are only mirrored under a
 * guarded prune that runs solely when data.authoritativeComplete === true and
 * only for EMPTY orphan devices with no pending work.
 *
 * Mocking follows __tests__/delta-sync.test.ts: vi.hoisted + an in-memory
 * better-sqlite3 DB injected for '@/lib/db-sqlite'. pull-guard is kept REAL.
 */

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  // L2 schema copied verbatim from lib/db-sqlite.ts.
  d.exec(`
    CREATE TABLE IF NOT EXISTS L2Sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudId INTEGER,
      Name TEXT NOT NULL,
      DisplayName TEXT,
      DisplayOrder INTEGER NOT NULL,
      Discipline TEXT,
      DeviceCount INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS L2Columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudId INTEGER,
      SheetId INTEGER NOT NULL REFERENCES L2Sheets(id) ON DELETE CASCADE,
      Name TEXT NOT NULL,
      ColumnType TEXT NOT NULL,
      InputType TEXT,
      DisplayOrder INTEGER NOT NULL,
      IsSystem INTEGER DEFAULT 0,
      IsEditable INTEGER DEFAULT 1,
      IncludeInProgress INTEGER DEFAULT 0,
      IsRequired INTEGER DEFAULT 0,
      Description TEXT,
      ApplicableMcms TEXT
    );
    CREATE TABLE IF NOT EXISTS L2Devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudId INTEGER,
      SubsystemId INTEGER,
      SheetId INTEGER NOT NULL REFERENCES L2Sheets(id) ON DELETE CASCADE,
      DeviceName TEXT NOT NULL,
      Mcm TEXT,
      Subsystem TEXT,
      DisplayOrder INTEGER NOT NULL,
      CompletedChecks INTEGER DEFAULT 0,
      TotalChecks INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS L2CellValues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudCellId INTEGER,
      DeviceId INTEGER NOT NULL REFERENCES L2Devices(id) ON DELETE CASCADE,
      ColumnId INTEGER NOT NULL REFERENCES L2Columns(id) ON DELETE CASCADE,
      Value TEXT,
      UpdatedBy TEXT,
      UpdatedAt TEXT DEFAULT (datetime('now')),
      Version INTEGER DEFAULT 0,
      UNIQUE(DeviceId, ColumnId)
    );
    CREATE TABLE IF NOT EXISTS L2PendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      CloudDeviceId INTEGER NOT NULL,
      CloudColumnId INTEGER NOT NULL,
      Value TEXT,
      UpdatedBy TEXT,
      Version INTEGER DEFAULT 0,
      CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0,
      LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0
    );
  `)
  return { memDb: d }
})

// db-sqlite: inject the in-memory DB. pull-guard is intentionally NOT mocked.
vi.mock('@/lib/db-sqlite', () => ({ db: memDb, extractDeviceName: () => null }))
// recovery-log: stub the audit sink so it never touches the filesystem.
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: vi.fn() }))
// dynamic import in the route: pre-pull backup must "succeed".
vi.mock('@/lib/db/backup', () => ({ createBackup: vi.fn(async () => ({ filename: 'test-backup.db' })) }))
// dynamic import in the route: PLC validation writer is best-effort.
vi.mock('@/lib/vfd-validation-writer', () => ({ triggerValidationSync: vi.fn(async () => {}) }))

// Cloud L2 payload the mocked fetch returns; each test assigns it via runPull.
let cloudPayload: any
global.fetch = vi.fn(async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => cloudPayload,
  text: async () => JSON.stringify(cloudPayload),
})) as any

import { POST } from '@/app/api/cloud/pull-l2/route'

const SID = 40

// ── payload builders (cloud shape) ──────────────────────────────────────────
const colPayload = (cloudColId: number, name = 'Check') => ({
  id: cloudColId, name, columnType: 'check', inputType: 'check', displayOrder: 1,
  isSystem: false, isEditable: true, includeInProgress: true, isRequired: false, description: null,
})
const sheetPayload = (cloudSheetId: number, cols: any[]) => ({
  id: cloudSheetId, name: 'FV', displayName: 'FV', displayOrder: 1, discipline: 'E', deviceCount: 0, columns: cols,
})
const devPayload = (cloudDevId: number, cloudSheetId: number, name = 'DEV') => ({
  id: cloudDevId, sheetId: cloudSheetId, deviceName: name, mcm: 'MCM01', subsystem: 'SUB',
  displayOrder: 1, completedChecks: 0, totalChecks: 1,
})
const cellPayload = (cloudCellId: number, cloudDevId: number, cloudColId: number, value: string | null, updatedAt: string) => ({
  id: cloudCellId, deviceId: cloudDevId, columnId: cloudColId, value, updatedBy: 'cloud', updatedAt, version: 1,
})

// ── local seed helpers ──────────────────────────────────────────────────────
function seedSheet(cloudSheetId: number): number {
  return memDb.prepare(
    'INSERT INTO L2Sheets (CloudId,Name,DisplayName,DisplayOrder,Discipline,DeviceCount) VALUES (?,?,?,?,?,?)',
  ).run(cloudSheetId, 'FV', 'FV', 1, 'E', 0).lastInsertRowid as number
}
function seedColumn(cloudColId: number, localSheetId: number): number {
  return memDb.prepare(
    'INSERT INTO L2Columns (CloudId,SheetId,Name,ColumnType,InputType,DisplayOrder,IsSystem,IsEditable,IncludeInProgress,IsRequired,Description) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).run(cloudColId, localSheetId, 'Check', 'check', 'check', 1, 0, 1, 1, 0, null).lastInsertRowid as number
}
function seedDevice(cloudDevId: number, localSheetId: number, opts: { subsystemId?: number | null; name?: string } = {}): number {
  return memDb.prepare(
    'INSERT INTO L2Devices (CloudId,SubsystemId,SheetId,DeviceName,Mcm,Subsystem,DisplayOrder,CompletedChecks,TotalChecks) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(cloudDevId, opts.subsystemId === undefined ? SID : opts.subsystemId, localSheetId, opts.name || 'DEV', 'MCM01', 'SUB', 1, 0, 1).lastInsertRowid as number
}
function seedCell(localDevId: number, localColId: number, value: string | null, updatedAt: string, cloudCellId: number | null = null): number {
  return memDb.prepare(
    'INSERT INTO L2CellValues (CloudCellId,DeviceId,ColumnId,Value,UpdatedBy,UpdatedAt,Version) VALUES (?,?,?,?,?,?,?)',
  ).run(cloudCellId, localDevId, localColId, value, 'local', updatedAt, 0).lastInsertRowid as number
}

const getCell = (id: number) => memDb.prepare('SELECT * FROM L2CellValues WHERE id = ?').get(id) as any
const getCellByDevCol = (devId: number, colId: number) => memDb.prepare('SELECT * FROM L2CellValues WHERE DeviceId=? AND ColumnId=?').get(devId, colId) as any
const getDeviceByCloudId = (cloudId: number) => memDb.prepare('SELECT * FROM L2Devices WHERE CloudId=?').get(cloudId) as any

async function runPull(payload: any, force = false) {
  cloudPayload = payload
  const req: any = { body: { remoteUrl: 'http://cloud', apiPassword: 'key', subsystemId: SID, force } }
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this },
    json(o: any) { this.body = o; return this },
  }
  await POST(req, res)
  return res
}

describe('pull-l2 non-destructive merge', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM L2CellValues; DELETE FROM L2Devices; DELETE FROM L2Columns; DELETE FROM L2Sheets; DELETE FROM L2PendingSyncs;')
    vi.clearAllMocks()
  })

  it('1. keeps a local FV cell the cloud payload does not (yet) carry', () => {
    // "10 cells entered locally, cloud doesn't have them yet, pull runs."
    const sh = seedSheet(100)
    const col = seedColumn(200, sh)
    const dev = seedDevice(300, sh)
    const cell = seedCell(dev, col, 'PASS', '2026-07-08T10:00:00.000Z')
    // Cloud serves the device but NO cell values.
    return runPull({ success: true, authoritativeComplete: false, sheets: [sheetPayload(100, [colPayload(200)])], devices: [devPayload(300, 100)], cellValues: [] }).then((res) => {
      expect(res.statusCode).toBe(200)
      expect(getCell(cell).Value).toBe('PASS') // survived — never deleted
    })
  })

  it('2. does NOT blank a filled local cell when cloud sends an empty value', async () => {
    const sh = seedSheet(100)
    const col = seedColumn(200, sh)
    const dev = seedDevice(300, sh)
    const cell = seedCell(dev, col, 'PASS', '2026-07-08T10:00:00.000Z')
    // Cloud has a NEWER but EMPTY value for the same cell.
    const res = await runPull({
      success: true, sheets: [sheetPayload(100, [colPayload(200)])], devices: [devPayload(300, 100)],
      cellValues: [cellPayload(1, 300, 200, '', '2026-07-09T10:00:00.000Z')],
    })
    expect(res.statusCode).toBe(200)
    expect(getCell(cell).Value).toBe('PASS') // filled local value preserved
  })

  it('3. NEVER overwrites an existing local cell, even when cloud looks newer (FV is field-authored, up-only)', async () => {
    const sh = seedSheet(100)
    const colA = seedColumn(200, sh)
    const colB = seedColumn(201, sh)
    const dev = seedDevice(300, sh)
    const cellA = seedCell(dev, colA, 'OLD', '2026-01-01T00:00:00.000Z')
    const cellB = seedCell(dev, colB, 'LOCAL-NEW', '2026-03-01T00:00:00.000Z')
    const res = await runPull({
      success: true,
      sheets: [sheetPayload(100, [colPayload(200), colPayload(201)])],
      devices: [devPayload(300, 100)],
      cellValues: [
        // Cloud claims a "newer" value — but nobody edits FV test data on the
        // cloud, so the pull must IGNORE it and keep the field's value.
        cellPayload(1, 300, 200, 'CLOUD-NEW', '2026-02-01T00:00:00.000Z'),
        cellPayload(2, 300, 201, 'CLOUD-OLD', '2026-01-01T00:00:00.000Z'),
      ],
    })
    expect(res.statusCode).toBe(200)
    expect(getCell(cellA).Value).toBe('OLD')       // existing local kept — cloud never overwrites
    expect(getCell(cellB).Value).toBe('LOCAL-NEW') // existing local kept
  })

  it('3b. FILLS an EMPTY local cell from cloud — the belt-tracking handoff', async () => {
    // The mechanical marks "Belt Tracked" on the cloud page; the field wizard
    // waits for that value to arrive. The local cell exists but is EMPTY, so the
    // cloud value must land (filling a blank never loses field work).
    const sh = seedSheet(100)
    const col = seedColumn(200, sh)
    const dev = seedDevice(300, sh)
    const emptyCell = seedCell(dev, col, '', '2026-07-08T09:00:00.000Z') // blank, awaiting tracking
    const res = await runPull({
      success: true,
      sheets: [sheetPayload(100, [colPayload(200)])],
      devices: [devPayload(300, 100)],
      cellValues: [cellPayload(1, 300, 200, 'ASH 9/5', '2026-07-08T10:00:00.000Z')], // mechanic filled it
    })
    expect(res.statusCode).toBe(200)
    expect(getCell(emptyCell).Value).toBe('ASH 9/5') // belt-tracked value delivered
  })

  it('3c. does NOT resurrect a value into a cell the operator cleared MORE recently than cloud', async () => {
    const sh = seedSheet(100)
    const col = seedColumn(200, sh)
    const dev = seedDevice(300, sh)
    // Local blank is NEWER than the cloud value → operator just cleared it; keep blank.
    const clearedCell = seedCell(dev, col, '', '2026-07-08T12:00:00.000Z')
    const res = await runPull({
      success: true,
      sheets: [sheetPayload(100, [colPayload(200)])],
      devices: [devPayload(300, 100)],
      cellValues: [cellPayload(1, 300, 200, 'STALE', '2026-07-08T10:00:00.000Z')],
    })
    expect(res.statusCode).toBe(200)
    expect((getCell(clearedCell).Value ?? '')).toBe('') // stale cloud value not resurrected
  })

  it('4. inserts a brand-new cloud cell', async () => {
    const sh = seedSheet(100)
    const col = seedColumn(200, sh)
    const dev = seedDevice(300, sh)
    // No local cell for (dev,col) yet.
    const res = await runPull({
      success: true, sheets: [sheetPayload(100, [colPayload(200)])], devices: [devPayload(300, 100)],
      cellValues: [cellPayload(1, 300, 200, 'FROM-CLOUD', '2026-07-09T10:00:00.000Z')],
    })
    expect(res.statusCode).toBe(200)
    const inserted = getCellByDevCol(dev, col)
    expect(inserted).toBeDefined()
    expect(inserted.Value).toBe('FROM-CLOUD')
  })

  it('5. does NOT prune an orphan device when authoritativeComplete is absent/false', async () => {
    const sh = seedSheet(100)
    seedColumn(200, sh)
    seedDevice(300, sh) // served by cloud
    seedDevice(901, sh) // orphan (absent from payload), no cells
    // authoritativeComplete omitted → prune must be skipped entirely.
    const res = await runPull({
      success: true, sheets: [sheetPayload(100, [colPayload(200)])], devices: [devPayload(300, 100)], cellValues: [],
    })
    expect(res.statusCode).toBe(200)
    expect(getDeviceByCloudId(901)).toBeDefined() // orphan kept — no destructive prune without the flag
  })

  it('6. authoritativeComplete: prunes an EMPTY orphan but keeps an orphan holding a filled cell', async () => {
    const sh = seedSheet(100)
    const col = seedColumn(200, sh)
    seedDevice(300, sh) // served
    seedDevice(901, sh) // orphan, EMPTY → should be pruned
    const filledOrphan = seedDevice(902, sh) // orphan, has real work → must survive
    seedCell(filledOrphan, col, 'REAL-WORK', '2026-07-08T10:00:00.000Z')
    const res = await runPull({
      success: true, authoritativeComplete: true,
      sheets: [sheetPayload(100, [colPayload(200)])], devices: [devPayload(300, 100)], cellValues: [],
    })
    expect(res.statusCode).toBe(200)
    expect(getDeviceByCloudId(901)).toBeUndefined() // empty orphan pruned
    expect(getDeviceByCloudId(902)).toBeDefined()   // orphan with a filled cell NEVER pruned
    expect(getCellByDevCol(filledOrphan, col).Value).toBe('REAL-WORK')
  })

  it('7. authoritativeComplete: an orphan device with a pending sync row is NEVER pruned', async () => {
    const sh = seedSheet(100)
    seedColumn(200, sh)
    seedDevice(300, sh) // served
    seedDevice(903, sh) // orphan, empty, but has unsynced pending work
    memDb.prepare('INSERT INTO L2PendingSyncs (CloudDeviceId,CloudColumnId,Value,UpdatedBy,Version,DeadLettered) VALUES (?,?,?,?,?,?)')
      .run(903, 200, 'PENDING', 'local', 0, 0)
    const res = await runPull({
      success: true, authoritativeComplete: true,
      sheets: [sheetPayload(100, [colPayload(200)])], devices: [devPayload(300, 100)], cellValues: [],
    })
    // The unsynced pending row trips the pending-queue guard (409) BEFORE the
    // pull runs at all, so the orphan is doubly protected: the pull is blocked
    // and nothing is pruned. (The prune loop's own pending check is redundant
    // belt-and-suspenders behind this guard — see summary.)
    expect(res.statusCode).toBe(409)
    expect(getDeviceByCloudId(903)).toBeDefined() // orphan with pending work never removed
  })

  it('8. a device moved to a different sheet on cloud updates SheetId locally and keeps its cells', async () => {
    const shA = seedSheet(100)
    const shB = seedSheet(101)
    const col = seedColumn(200, shA)
    const dev = seedDevice(300, shA) // currently on sheet A
    const cell = seedCell(dev, col, 'KEEP-ME', '2026-07-08T10:00:00.000Z')
    // Cloud now reports device 300 on sheet 101 (B).
    const res = await runPull({
      success: true,
      sheets: [sheetPayload(100, [colPayload(200)]), sheetPayload(101, [colPayload(201)])],
      devices: [devPayload(300, 101)],
      cellValues: [],
    })
    expect(res.statusCode).toBe(200)
    const moved = getDeviceByCloudId(300)
    expect(moved.SheetId).toBe(shB) // re-parented to sheet B's local id
    expect(getCell(cell).Value).toBe('KEEP-ME') // cells preserved across the move
  })

  it('9. blocks the pull with 409 when the subsystem has pending L2 syncs, and wipes nothing', async () => {
    const sh = seedSheet(100)
    const col = seedColumn(200, sh)
    const dev = seedDevice(300, sh)
    const cell = seedCell(dev, col, 'UNSYNCED', '2026-07-08T10:00:00.000Z')
    memDb.prepare('INSERT INTO L2PendingSyncs (CloudDeviceId,CloudColumnId,Value,UpdatedBy,Version,DeadLettered) VALUES (?,?,?,?,?,?)')
      .run(300, 200, 'UNSYNCED', 'local', 0, 0)
    // Cloud would send an authoritative empty set — must NOT be applied.
    const res = await runPull({
      success: true, authoritativeComplete: true,
      sheets: [sheetPayload(100, [colPayload(200)])], devices: [], cellValues: [],
    })
    expect(res.statusCode).toBe(409)
    expect(res.body.success).toBe(false)
    expect(getCell(cell).Value).toBe('UNSYNCED') // untouched
    expect(getDeviceByCloudId(300)).toBeDefined()
    // fetch is never even called once the queue guard blocks.
    expect((global.fetch as any)).not.toHaveBeenCalled()
  })
})
