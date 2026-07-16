/**
 * Result-level sync tombstone (Ios.CloudRemoved).
 *
 * When the cloud PERMANENTLY removed an IO (403/404/410), its local result is
 * tombstoned so it (a) stops tripping the destructive-pull "would erase" guard
 * — which reads Ios directly and warned forever — and (b) stops being re-queued
 * by the orphan reconciler after the operator discards its queue row (the
 * discard→reconcile→404→orphan loop). This locks that behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE Ios (id INTEGER PRIMARY KEY, Name TEXT, SubsystemId INTEGER, Result TEXT, Comments TEXT, Timestamp TEXT, CloudRemoved INTEGER DEFAULT 0);
    CREATE TABLE PendingSyncs (IoId INTEGER);
    CREATE TABLE TestHistories (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, Result TEXT, Timestamp TEXT);
  `)
  return { memDb: d }
})

import { computePullRiskOrRefuse } from '@/lib/cloud/pull-guard'
import { computeReconcileEnqueues } from '@/lib/cloud/result-reconciler'

const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})
// Cloud payload that lacks the local result → the classic "would erase" shape.
const cloudLacksResult = [{ id: 1, result: null, comments: null }]

beforeEach(() => {
  memDb.exec('DELETE FROM Ios; DELETE FROM PendingSyncs; DELETE FROM TestHistories;')
  memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result, Comments, Timestamp, CloudRemoved) VALUES (?,?,?,?,?,?,?)')
    .run(1, 'NCR1_11_VFD:I.In_0', 47, 'Passed', 'field note', '2026-07-16T00:00:00.000Z', 0)
})

describe('pull guard vs the tombstone', () => {
  it('a LIVE (CloudRemoved=0) result the cloud lacks still refuses the pull', () => {
    warn()
    const d = computePullRiskOrRefuse({ db: memDb, subsystemId: 47, logPrefix: '[MCM 47 Pull]' }, cloudLacksResult, false)
    expect(d.refuse).not.toBeNull()
    expect((d.refuse!.body as Record<string, unknown>).wouldLoseResults).toBe(1)
    expect((d.refuse!.body as Record<string, unknown>).wouldLoseComments).toBe(1)
  })

  it('a TOMBSTONED (CloudRemoved=1) result is EXCLUDED — no refuse, nothing to erase', () => {
    warn()
    memDb.prepare('UPDATE Ios SET CloudRemoved = 1 WHERE id = 1').run()
    const d = computePullRiskOrRefuse({ db: memDb, subsystemId: 47, logPrefix: '[MCM 47 Pull]' }, cloudLacksResult, false)
    expect(d.refuse).toBeNull()
    expect(d.atRisk).toHaveLength(0)
    expect(d.atRiskComments).toHaveLength(0)
  })
})

describe('reconciler vs the tombstone', () => {
  const cloudEmpty = [{ id: 1, result: null, comments: null, version: 0 }]
  const localRow = {
    id: 1, Name: 'NCR1_11_VFD:I.In_0', Result: 'Passed', Comments: 'field note',
    TestedBy: 'tech', Timestamp: '2026-07-16T00:00:00.000Z', Version: 0, Trade: null, FailureMode: null,
  }

  it('re-enqueues a live orphan result the cloud lacks', () => {
    const out = computeReconcileEnqueues([localRow as never], cloudEmpty, new Set())
    expect(out).toHaveLength(1)
    expect(out[0].ioId).toBe(1)
  })

  it('does NOT re-enqueue when the IO already has a queue row (no churn)', () => {
    const out = computeReconcileEnqueues([localRow as never], cloudEmpty, new Set([1]))
    expect(out).toHaveLength(0)
  })
})
