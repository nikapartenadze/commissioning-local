/**
 * F8 (2026-07-03 sync audit): the stuck-sync surface + un-park recovery path
 * must cover ALL durable queues, not just IO. Before this, parked L2 / e-stop
 * (SAFETY data) / guided / device-blocker rows were invisible and had no
 * operator recovery path.
 *
 * Mocks @/lib/db-sqlite with an in-memory DB carrying the five queue tables,
 * then drives the stuck-list GET and the unpark POST handlers directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE Ios (id INTEGER PRIMARY KEY, SubsystemId INTEGER, Name TEXT, Result TEXT, CloudRemoved INTEGER DEFAULT 0);
    CREATE TABLE PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, InspectorName TEXT,
      TestResult TEXT, Comments TEXT, State TEXT, Version INTEGER, CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0, LastError TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE EStopCheckPendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      ZoneName TEXT, CheckTag TEXT, Result TEXT, TestedBy TEXT, Version INTEGER DEFAULT 0,
      CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE GuidedTaskStatePendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      TaskId TEXT, Status TEXT, ActorName TEXT, CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0, LastError TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE DeviceBlockerPendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER,
      DeviceName TEXT, Op TEXT, BlockerResponsibleParty TEXT, BlockerDescription TEXT, UpdatedBy TEXT,
      CreatedAt TEXT DEFAULT (datetime('now')), RetryCount INTEGER DEFAULT 0, LastError TEXT,
      DeadLettered INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE L2Devices (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudId INTEGER, SubsystemId INTEGER, DeviceName TEXT);
    CREATE TABLE L2PendingSyncs (id INTEGER PRIMARY KEY AUTOINCREMENT, CloudDeviceId INTEGER, CloudColumnId INTEGER,
      Value TEXT, UpdatedBy TEXT, Version INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now')),
      RetryCount INTEGER DEFAULT 0, LastError TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0, Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
  `)
  return { memDb: d }
})

vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))
vi.mock('@/lib/logging/recovery-log', () => ({ auditLog: vi.fn() }))

import { GET as stuckGET } from '@/app/api/cloud/stuck/route'
import { POST as unparkPOST } from '@/app/api/cloud/unpark/route'

function mockRes() {
  const res: any = {}
  res.statusCode = 200
  res.status = (c: number) => { res.statusCode = c; return res }
  res.json = (b: any) => { res.body = b; return res }
  return res
}

beforeEach(() => {
  for (const t of ['PendingSyncs', 'EStopCheckPendingSyncs', 'GuidedTaskStatePendingSyncs', 'DeviceBlockerPendingSyncs', 'L2PendingSyncs', 'L2Devices', 'Ios']) {
    memDb.exec(`DELETE FROM ${t}`)
  }
  vi.clearAllMocks()
})

describe('GET /api/cloud/stuck — all queues (F8)', () => {
  it('surfaces parked rows from every queue, tagged by queue', async () => {
    memDb.prepare("INSERT INTO Ios (id, SubsystemId, Name, Result) VALUES (1, 40, 'IO_A', 'Passed')").run()
    memDb.prepare("INSERT INTO PendingSyncs (IoId, TestResult, Version, DeadLettered) VALUES (1, 'Passed', 2, 1)").run()
    memDb.prepare("INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CheckTag, Result, DeadLettered) VALUES (40, 'Z1', 'T1', 'Passed', 1)").run()
    memDb.prepare("INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status, RetryCount) VALUES (40, 'task-1', 'completed', 3)").run()
    memDb.prepare("INSERT INTO DeviceBlockerPendingSyncs (SubsystemId, DeviceName, Op, DeadLettered) VALUES (40, 'VFD1', 'set', 1)").run()
    memDb.prepare("INSERT INTO L2Devices (CloudId, SubsystemId, DeviceName) VALUES (500, 40, 'DEV')").run()
    memDb.prepare("INSERT INTO L2PendingSyncs (CloudDeviceId, CloudColumnId, Value, DeadLettered) VALUES (500, 20, 'Passed', 1)").run()

    const res = mockRes()
    await stuckGET({ query: {} } as any, res)

    expect(res.body.success).toBe(true)
    expect(res.body.count).toBe(5)
    expect(res.body.byQueue).toEqual({ io: 1, estop: 1, guided: 1, 'device-blocker': 1, l2: 1 })
    // e-stop (safety) is now visible — the core of F8
    expect(res.body.items.some((i: any) => i.queue === 'estop')).toBe(true)
    // IO carries the force-push flag; the others don't
    expect(res.body.items.find((i: any) => i.queue === 'io').forcePushSupported).toBe(true)
    expect(res.body.items.find((i: any) => i.queue === 'estop').forcePushSupported).toBe(false)
  })

  it('scopes every queue by subsystemId', async () => {
    memDb.prepare("INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CheckTag, Result, DeadLettered) VALUES (40, 'Z1', 'T1', 'Passed', 1)").run()
    memDb.prepare("INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CheckTag, Result, DeadLettered) VALUES (41, 'Z2', 'T2', 'Passed', 1)").run()

    const res = mockRes()
    await stuckGET({ query: { subsystemId: '40' } } as any, res)
    expect(res.body.count).toBe(1)
    expect(res.body.items[0].subsystemId).toBe(40)
  })
})

describe('POST /api/cloud/unpark (F8)', () => {
  it('un-parks a single non-IO row (clears DeadLettered + RetryCount) so the drain retries it', async () => {
    const info = memDb.prepare("INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CheckTag, Result, RetryCount, DeadLettered) VALUES (40, 'Z1', 'T1', 'Passed', 10, 1)").run()

    const res = mockRes()
    await unparkPOST({ body: { queue: 'estop', pendingId: info.lastInsertRowid } } as any, res)

    expect(res.body).toEqual({ success: true, queue: 'estop', unparked: 1 })
    const row = memDb.prepare('SELECT DeadLettered, RetryCount FROM EStopCheckPendingSyncs WHERE id = ?').get(info.lastInsertRowid) as any
    expect(row.DeadLettered).toBe(0)
    expect(row.RetryCount).toBe(0)
  })

  it('bulk un-parks by subsystem for queues that carry a subsystem column', async () => {
    memDb.prepare("INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status, DeadLettered) VALUES (40, 'a', 'completed', 1)").run()
    memDb.prepare("INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status, DeadLettered) VALUES (40, 'b', 'completed', 1)").run()
    memDb.prepare("INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status, DeadLettered) VALUES (41, 'c', 'completed', 1)").run()

    const res = mockRes()
    await unparkPOST({ body: { queue: 'guided', subsystemId: 40, all: true } } as any, res)
    expect(res.body.unparked).toBe(2)
    expect((memDb.prepare('SELECT COUNT(*) c FROM GuidedTaskStatePendingSyncs WHERE DeadLettered = 1').get() as any).c).toBe(1)
  })

  it('rejects an unknown queue and the IO queue (IO uses push-force)', async () => {
    const r1 = mockRes()
    await unparkPOST({ body: { queue: 'bogus', pendingId: 1 } } as any, r1)
    expect(r1.statusCode).toBe(400)

    const r2 = mockRes()
    await unparkPOST({ body: { queue: 'io', pendingId: 1 } } as any, r2)
    expect(r2.statusCode).toBe(400)
  })
})
