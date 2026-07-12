/**
 * F3 (FV-HARDENING-PLAN.md): every FAILURE path of POST /api/l2/cell must leave
 * a durable l2.cell.fail audit record carrying the rejected VALUE. The
 * 2026-07-11 MCM04 loss was 114 consecutive rejected saves that left no trace
 * anywhere — the only copy of the work was browser memory.
 *
 * Also covers the outbox-eviction report route (F4 server side).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE L2Columns (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SheetId INTEGER, Name TEXT, IncludeInProgress INTEGER DEFAULT 0);
    CREATE TABLE L2Devices (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SubsystemId INTEGER, SheetId INTEGER, DeviceName TEXT, CompletedChecks INTEGER DEFAULT 0);
    CREATE TABLE L2CellValues (id INTEGER PRIMARY KEY AUTOINCREMENT, DeviceId INTEGER, ColumnId INTEGER, Value TEXT, UpdatedBy TEXT, UpdatedAt TEXT, Version INTEGER DEFAULT 0, UNIQUE(DeviceId, ColumnId));
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudDeviceId INTEGER, CloudColumnId INTEGER, Value TEXT, UpdatedBy TEXT, Version INTEGER DEFAULT 0, RetryCount INTEGER DEFAULT 0, LastError TEXT);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: vi.fn() }))
vi.mock('@/lib/cloud/sync-queue', () => ({ enqueueSyncPush: vi.fn() }))
vi.mock('@/lib/config', () => ({ configService: { getConfig: vi.fn(async () => ({ remoteUrl: '' })) } }))

import { POST } from '@/app/api/l2/cell/route'
import { POST as evictedPOST } from '@/app/api/l2/outbox-evicted/route'
import { auditLog } from '@/lib/logging/recovery-log'

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this },
    json(o: any) { this.body = o; return this },
  }
}

const auditMock = vi.mocked(auditLog)
const failAudits = () => auditMock.mock.calls.map(c => c[0]).filter(e => e.type === 'l2.cell.fail')

beforeEach(() => {
  memDb.exec('DELETE FROM L2CellValues; DELETE FROM L2Devices; DELETE FROM L2Columns; DELETE FROM L2PendingSyncs;')
  vi.clearAllMocks()
})

describe('POST /api/l2/cell — failure paths are audited (l2.cell.fail)', () => {
  it('400 missing ids → audited with the rejected value', async () => {
    const res = fakeRes()
    await POST({ body: { value: 'Pass', updatedBy: 'tech' } } as any, res as any)
    expect(res.statusCode).toBe(400)
    const fails = failAudits()
    expect(fails).toHaveLength(1)
    expect(fails[0].user).toBe('tech')
    expect(fails[0].reason).toContain('400')
    expect(fails[0].detail?.value).toBe('Pass')
  })

  it('404 stale local id → audited with device/column presence + value', async () => {
    const res = fakeRes()
    await POST({ body: { deviceId: 999, columnId: 888, value: 'Fail', updatedBy: 'santiago' } } as any, res as any)
    expect(res.statusCode).toBe(404)
    const fails = failAudits()
    expect(fails).toHaveLength(1)
    expect(fails[0].reason).toContain('stale')
    expect(fails[0].detail).toMatchObject({ deviceId: 999, columnId: 888, value: 'Fail', deviceFound: false, columnFound: false })
  })

  it('500 (db blows up mid-write) → audited with the rejected value', async () => {
    // Valid device+column so the handler passes the 404 guard…
    const devId = memDb.prepare('INSERT INTO L2Devices (CloudId,SubsystemId,SheetId,DeviceName) VALUES (1,16,1,?)').run('ENC-01').lastInsertRowid
    const colId = memDb.prepare('INSERT INTO L2Columns (CloudId,SheetId,Name) VALUES (2,1,?)').run('Verify Identity').lastInsertRowid
    // …then make the write itself fail, like the FK violation storm did.
    memDb.exec('DROP TABLE L2CellValues')
    const res = fakeRes()
    await POST({ body: { deviceId: devId, columnId: colId, value: 'PS 7/11', updatedBy: 'peter' } } as any, res as any)
    expect(res.statusCode).toBe(500)
    const fails = failAudits()
    expect(fails).toHaveLength(1)
    expect(fails[0].reason).toContain('500')
    expect(fails[0].detail?.value).toBe('PS 7/11')
    // restore for other tests
    memDb.exec('CREATE TABLE L2CellValues (id INTEGER PRIMARY KEY AUTOINCREMENT, DeviceId INTEGER, ColumnId INTEGER, Value TEXT, UpdatedBy TEXT, UpdatedAt TEXT, Version INTEGER DEFAULT 0, UNIQUE(DeviceId, ColumnId))')
  })

  it('success path still audits l2.cell (unchanged)', async () => {
    const devId = memDb.prepare('INSERT INTO L2Devices (CloudId,SubsystemId,SheetId,DeviceName) VALUES (1,16,1,?)').run('ENC-01').lastInsertRowid
    const colId = memDb.prepare('INSERT INTO L2Columns (CloudId,SheetId,Name) VALUES (2,1,?)').run('Verify Identity').lastInsertRowid
    const res = fakeRes()
    await POST({ body: { deviceId: devId, columnId: colId, value: 'ok', updatedBy: 'tech' } } as any, res as any)
    expect(res.statusCode).toBe(200)
    expect(failAudits()).toHaveLength(0)
    expect(auditMock.mock.calls.some(c => c[0].type === 'l2.cell')).toBe(true)
  })
})

describe('POST /api/l2/outbox-evicted — client evictions land in the recovery log', () => {
  it('writes one l2.outbox.evict per edit, carrying the lost value', async () => {
    const res = fakeRes()
    await evictedPOST({
      body: { edits: [
        { deviceId: 1, columnId: 2, value: 'Pass', updatedBy: 'tech', ts: 5, attempts: 5 },
        { deviceId: 3, columnId: 4, value: 'SM 7/11', updatedBy: 'santiago', ts: 6, attempts: 5 },
      ] },
    } as any, res as any)
    expect(res.statusCode).toBe(200)
    const evicts = auditMock.mock.calls.map(c => c[0]).filter(e => e.type === 'l2.outbox.evict')
    expect(evicts).toHaveLength(2)
    expect(evicts[1].detail).toMatchObject({ deviceId: 3, columnId: 4, value: 'SM 7/11' })
    expect(evicts[1].user).toBe('santiago')
  })

  it('rejects an empty report with 400', async () => {
    const res = fakeRes()
    await evictedPOST({ body: {} } as any, res as any)
    expect(res.statusCode).toBe(400)
  })
})
