import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * R6 (CDW5-polarity data-loss class): a wizard L2 cell whose column is not found
 * in the sheet is DROPPED. The route used to still return HTTP 200, so a caller
 * that only checks the status code never learned the operator's value (e.g.
 * "Polarity") was discarded. The route now returns HTTP 422 with a `dropped`
 * list when ANY cell is dropped, while still persisting the cells that matched.
 *
 * FILE UNDER TEST: app/api/vfd-commissioning/write-l2-cells/route.ts (POST).
 * Mocking mirrors __tests__/pull-l2-nondestructive.test.ts (vi.hoisted in-memory DB).
 */

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE L2Sheets (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, Name TEXT, DisplayName TEXT);
    CREATE TABLE L2Columns (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SheetId INTEGER, Name TEXT, ColumnType TEXT, IsEditable INTEGER DEFAULT 1, IncludeInProgress INTEGER DEFAULT 0);
    CREATE TABLE L2Devices (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SubsystemId INTEGER, SheetId INTEGER, DeviceName TEXT, CompletedChecks INTEGER DEFAULT 0);
    CREATE TABLE L2CellValues (id INTEGER PRIMARY KEY AUTOINCREMENT, DeviceId INTEGER, ColumnId INTEGER, Value TEXT, UpdatedBy TEXT, UpdatedAt TEXT, Version INTEGER DEFAULT 0, UNIQUE(DeviceId, ColumnId));
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudDeviceId INTEGER, CloudColumnId INTEGER, Value TEXT, UpdatedBy TEXT, Version INTEGER DEFAULT 0);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: vi.fn() }))
vi.mock('@/lib/cloud/sync-queue', () => ({ enqueueSyncPush: vi.fn() }))
vi.mock('@/lib/config', () => ({ configService: { getConfig: vi.fn(async () => ({ remoteUrl: '' })) } }))
vi.mock('@/lib/broadcast-config', () => ({ getBroadcastUrl: () => 'http://127.0.0.1:3102/broadcast' }))
vi.mock('@/lib/vfd-validation-writer', () => ({ triggerValidationSync: vi.fn(async () => {}) }))

global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any

import { POST } from '@/app/api/vfd-commissioning/write-l2-cells/route'

async function run(cells: Array<{ columnName: string; value: string | null }>) {
  const req: any = { body: { deviceName: 'DEV', updatedBy: 'ASH', cells } }
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(c: number) { this.statusCode = c; return this },
    json(o: any) { this.body = o; return this },
  }
  await POST(req, res)
  return res
}

describe('write-l2-cells drop → 422', () => {
  beforeEach(() => {
    memDb.exec('DELETE FROM L2CellValues; DELETE FROM L2Devices; DELETE FROM L2Columns; DELETE FROM L2Sheets; DELETE FROM L2PendingSyncs;')
    const sheetId = memDb.prepare('INSERT INTO L2Sheets (CloudId,Name,DisplayName) VALUES (NULL,?,?)').run('APF', 'APF').lastInsertRowid
    memDb.prepare('INSERT INTO L2Columns (CloudId,SheetId,Name,ColumnType,IsEditable,IncludeInProgress) VALUES (NULL,?,?,?,1,1)').run(sheetId, 'Check Direction', 'text')
    memDb.prepare('INSERT INTO L2Devices (CloudId,SubsystemId,SheetId,DeviceName) VALUES (NULL,16,?,?)').run(sheetId, 'DEV')
    vi.clearAllMocks()
  })

  it('returns 422 and lists dropped cells when a column is not found, but still writes the matched cell', async () => {
    const res = await run([
      { columnName: 'Check Direction', value: 'ASH 9/9' }, // matches
      { columnName: 'Polarity', value: 'NORMAL' },          // no such column → dropped
    ])

    expect(res.statusCode).toBe(422)
    expect(res.body.success).toBe(false)
    expect(res.body.dropped).toHaveLength(1)
    expect(res.body.dropped[0].columnName).toBe('Polarity')
    expect(res.body.dropped[0].ok).toBe(false)

    // The matched cell WAS persisted despite the sibling drop.
    const written = res.body.written.find((w: any) => w.columnName === 'Check Direction')
    expect(written.ok).toBe(true)
    const cell = memDb.prepare("SELECT Value FROM L2CellValues cv JOIN L2Columns c ON cv.ColumnId=c.id WHERE c.Name='Check Direction'").get() as any
    expect(cell.Value).toBe('ASH 9/9')
  })

  it('returns 200 when every cell matches a column', async () => {
    const res = await run([{ columnName: 'Check Direction', value: 'ASH 9/9' }])
    expect(res.statusCode).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.dropped).toHaveLength(0)
  })
})
