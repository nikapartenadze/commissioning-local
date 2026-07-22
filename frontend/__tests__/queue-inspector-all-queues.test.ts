/**
 * Sync Center = single source of truth: the queue inspector must surface ALL
 * FIVE outbound queues — including the e-stop (SAFETY) and guided queues that
 * previously had NO operator UI and no retry/discard path at all. Those two
 * tables have DeadLettered but NO Orphaned column, so retry() must not reference
 * Orphaned for them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  return { memDb: new Database(':memory:') }
})
vi.mock('@/lib/db-sqlite', () => ({ db: memDb }))

import { listQueue, retry, discard, selectRefs } from '@/lib/sync/queue-inspector'

beforeEach(() => {
  memDb.exec(`
    DROP TABLE IF EXISTS Subsystems;
    DROP TABLE IF EXISTS EStopCheckPendingSyncs;
    DROP TABLE IF EXISTS GuidedTaskStatePendingSyncs;
    CREATE TABLE Subsystems (id INTEGER PRIMARY KEY, Name TEXT);
    INSERT INTO Subsystems (id, Name) VALUES (51, 'MCM15');
    -- e-stop: DeadLettered, NO Orphaned (matches production ALTERs)
    CREATE TABLE EStopCheckPendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER NOT NULL, ZoneName TEXT, CheckTag TEXT,
      Result TEXT, CheckType TEXT DEFAULT 'preliminary', DeadLettered INTEGER NOT NULL DEFAULT 0,
      LastError TEXT, RetryCount INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now'))
    , Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
    CREATE TABLE GuidedTaskStatePendingSyncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER NOT NULL, TaskId TEXT, Status TEXT,
      Reason TEXT, DeadLettered INTEGER NOT NULL DEFAULT 0, LastError TEXT,
      RetryCount INTEGER DEFAULT 0, CreatedAt TEXT DEFAULT (datetime('now'))
    , Resolved INTEGER NOT NULL DEFAULT 0, ResolvedAt TEXT, ResolvedReason TEXT);
  `)
})

describe('queue-inspector surfaces the e-stop (safety) + guided queues', () => {
  it('lists a PARKED e-stop check and guided override (previously invisible)', () => {
    memDb.prepare(`INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, CheckTag, Result, DeadLettered, LastError, RetryCount) VALUES (51,'Zone A','EPC_1','Passed',1,'HTTP 500',10)`).run()
    memDb.prepare(`INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, Status, DeadLettered, LastError, RetryCount) VALUES (51,'task-42','skipped',1,'HTTP 500',10)`).run()

    const { items, summary } = listQueue({ status: 'all' })
    const kinds = items.map(i => i.kind).sort()
    expect(kinds).toEqual(['estop', 'guided'])
    expect(summary.parked).toBe(2)

    const estop = items.find(i => i.kind === 'estop')!
    expect(estop.status).toBe('parked')
    expect(estop.title).toBe('Zone A')
    expect(estop.mcm).toBe('MCM15')
    const guided = items.find(i => i.kind === 'guided')!
    expect(guided.title).toBe('task-42')
    expect(guided.subtitle).toBe('skipped')
  })

  it('RETRY un-parks an e-stop / guided row WITHOUT referencing the missing Orphaned column', () => {
    const e = memDb.prepare(`INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, DeadLettered, RetryCount, LastError) VALUES (51,'Z',1,10,'x')`).run()
    const g = memDb.prepare(`INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, DeadLettered, RetryCount, LastError) VALUES (51,'t',1,10,'x')`).run()
    const { affected } = retry([{ kind: 'estop', id: Number(e.lastInsertRowid) }, { kind: 'guided', id: Number(g.lastInsertRowid) }])
    expect(affected).toBe(2)
    expect((memDb.prepare('SELECT DeadLettered, RetryCount, LastError FROM EStopCheckPendingSyncs WHERE id=?').get(e.lastInsertRowid) as any)).toMatchObject({ DeadLettered: 0, RetryCount: 0, LastError: null })
    expect((memDb.prepare('SELECT DeadLettered FROM GuidedTaskStatePendingSyncs WHERE id=?').get(g.lastInsertRowid) as any).DeadLettered).toBe(0)
  })

  it('DISCARD removes only the queue row for the new kinds', () => {
    const e = memDb.prepare(`INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, DeadLettered) VALUES (51,'Z',1)`).run()
    expect(discard([{ kind: 'estop', id: Number(e.lastInsertRowid) }]).affected).toBe(1)
    expect(memDb.prepare('SELECT COUNT(*) c FROM EStopCheckPendingSyncs').get() as any).toMatchObject({ c: 0 })
  })

  it('selectRefs(allParked) includes the e-stop + guided rows for Retry-all', () => {
    memDb.prepare(`INSERT INTO EStopCheckPendingSyncs (SubsystemId, ZoneName, DeadLettered) VALUES (51,'Z',1)`).run()
    memDb.prepare(`INSERT INTO GuidedTaskStatePendingSyncs (SubsystemId, TaskId, DeadLettered) VALUES (51,'t',1)`).run()
    const refs = selectRefs({ allParked: true })
    expect(refs.map(r => r.kind).sort()).toEqual(['estop', 'guided'])
  })
})
