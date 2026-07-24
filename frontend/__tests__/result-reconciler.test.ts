import { describe, it, expect } from 'vitest'
import {
  computeReconcileEnqueues,
  type LocalResultRow,
  type CloudIoState,
} from '@/lib/cloud/result-reconciler'

const row = (over: Partial<LocalResultRow> & { id: number }): LocalResultRow => ({
  Result: null,
  Comments: null,
  TestedBy: null,
  Timestamp: null,
  Version: 0,
  Trade: null,
  FailureMode: null,
  ...over,
})

const NONE = new Set<number>()

describe('computeReconcileEnqueues', () => {
  it('re-enqueues a result orphan the cloud is missing', () => {
    const local = [row({ id: 1, Result: 'Passed', TestedBy: 'kev', Timestamp: 't1', Version: 5 })]
    const cloud: CloudIoState[] = [{ id: 1, result: null, version: 2 }]

    const out = computeReconcileEnqueues(local, cloud, NONE)

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ ioId: 1, testResult: 'Passed', inspectorName: 'kev', kind: 'result' })
    // base version is the CLOUD's current version, not the local one
    expect(out[0].version).toBe(2)
  })

  it('carries the comment + failure mode on a result orphan', () => {
    const local = [row({ id: 1, Result: 'Failed', Comments: 'temp pass', FailureMode: 'wiring', Version: 3 })]
    const cloud: CloudIoState[] = [{ id: 1, result: '', comments: '', version: 0 }]

    const out = computeReconcileEnqueues(local, cloud, NONE)

    expect(out[0]).toMatchObject({ testResult: 'Failed', comments: 'temp pass', failureMode: 'wiring' })
  })

  it('does NOT enqueue when the cloud already has the result', () => {
    const local = [row({ id: 1, Result: 'Passed' })]
    const cloud: CloudIoState[] = [{ id: 1, result: 'Passed', version: 7 }]
    expect(computeReconcileEnqueues(local, cloud, NONE)).toEqual([])
  })

  it('does NOT enqueue when the cloud holds a DIFFERENT result (last-write-wins)', () => {
    const local = [row({ id: 1, Result: 'Passed' })]
    const cloud: CloudIoState[] = [{ id: 1, result: 'Failed', version: 9 }]
    expect(computeReconcileEnqueues(local, cloud, NONE)).toEqual([])
  })

  it('skips IOs that already have a queue row (active or parked)', () => {
    const local = [row({ id: 1, Result: 'Passed' }), row({ id: 2, Result: 'Passed' })]
    const cloud: CloudIoState[] = [{ id: 1, result: null }, { id: 2, result: null }]

    const out = computeReconcileEnqueues(local, cloud, new Set([1]))

    expect(out.map((e) => e.ioId)).toEqual([2])
  })

  it('enqueues a comment-only orphan as a Comment Added op (result already on cloud)', () => {
    const local = [row({ id: 1, Result: 'Passed', Comments: 'field note', Version: 4 })]
    const cloud: CloudIoState[] = [{ id: 1, result: 'Passed', comments: null, version: 4 }]

    const out = computeReconcileEnqueues(local, cloud, NONE)

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ ioId: 1, testResult: 'Comment Added', comments: 'field note', kind: 'comment' })
  })

  it('treats a missing cloud IO (absent from payload) as an orphan', () => {
    const local = [row({ id: 99, Result: 'Passed' })]
    const out = computeReconcileEnqueues(local, [], NONE)
    expect(out).toHaveLength(1)
    expect(out[0].version).toBe(0)
  })

  it('does not double-enqueue: a result orphan emits one row, not a separate comment row', () => {
    const local = [row({ id: 1, Result: 'Passed', Comments: 'note' })]
    const cloud: CloudIoState[] = [{ id: 1, result: null, comments: null }]
    const out = computeReconcileEnqueues(local, cloud, NONE)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('result')
  })
})

// ── Crash-lost CLEAR re-push (2026-07-24 convergence gap) ────────────────────
// A deliberate local clear whose enqueue was lost leaves the cloud holding the
// stale Passed/Failed forever while the field refuses to re-absorb it. The
// reconciler pushes the clear ONLY with positive recency proof; everything
// unprovable is surfaced as unresolved, never pushed.
import {
  computeClearReenqueues,
  type LocalClearCandidateRow,
} from '@/lib/cloud/result-reconciler'

const clearRow = (over: Partial<LocalClearCandidateRow> & { id: number }): LocalClearCandidateRow => ({
  lastResult: 'Cleared',
  clearedAt: '2026-07-10 10:00:00', // SQLite shape — parsed as UTC
  clearedBy: 'kev',
  clearComment: 'Cleared Passed result',
  ...over,
})

describe('computeClearReenqueues (crash-lost clears)', () => {
  it('re-enqueues a Cleared push when the clear is provably newer than the cloud value', () => {
    const cloud: CloudIoState[] = [
      { id: 1, result: 'Passed', version: 7, timestamp: '2026-07-09T10:00:00.000Z' },
    ]
    const { enqueues, unresolved } = computeClearReenqueues([clearRow({ id: 1 })], cloud, NONE)

    expect(unresolved).toEqual([])
    expect(enqueues).toHaveLength(1)
    expect(enqueues[0]).toMatchObject({
      ioId: 1,
      testResult: 'Cleared',
      kind: 'clear',
      inspectorName: 'kev',
      comments: 'Cleared Passed result',
      failureMode: null,
      trade: null,
    })
    // base version = the cloud's CURRENT version (first-try acceptance)
    expect(enqueues[0].version).toBe(7)
    // timestamp = the clear instant, normalized to ISO UTC
    expect(enqueues[0].timestamp).toBe('2026-07-10T10:00:00.000Z')
  })

  it('does NOT push when the cloud value is provably newer (normal LWW, no unresolved log)', () => {
    const cloud: CloudIoState[] = [
      { id: 1, result: 'Passed', version: 7, timestamp: '2026-07-11T10:00:00.000Z' },
    ]
    const { enqueues, unresolved } = computeClearReenqueues([clearRow({ id: 1 })], cloud, NONE)
    expect(enqueues).toEqual([])
    expect(unresolved).toEqual([])
  })

  it('UNRESOLVED (never pushed) when the clear has no parseable timestamp', () => {
    const cloud: CloudIoState[] = [{ id: 1, result: 'Failed', timestamp: '2026-07-09T10:00:00.000Z' }]
    const { enqueues, unresolved } = computeClearReenqueues(
      [clearRow({ id: 1, clearedAt: null })], cloud, NONE,
    )
    expect(enqueues).toEqual([])
    expect(unresolved).toEqual([{ ioId: 1, cloudResult: 'Failed', reason: 'no-clear-timestamp' }])
  })

  it('UNRESOLVED (never pushed) when the cloud value has no parseable timestamp', () => {
    const cloud: CloudIoState[] = [{ id: 1, result: 'Passed', timestamp: null }]
    const { enqueues, unresolved } = computeClearReenqueues([clearRow({ id: 1 })], cloud, NONE)
    expect(enqueues).toEqual([])
    expect(unresolved).toEqual([{ ioId: 1, cloudResult: 'Passed', reason: 'no-cloud-timestamp' }])
  })

  it('UNRESOLVED on an exact timestamp tie', () => {
    const cloud: CloudIoState[] = [
      { id: 1, result: 'Passed', timestamp: '2026-07-10T10:00:00.000Z' },
    ]
    const { enqueues, unresolved } = computeClearReenqueues([clearRow({ id: 1 })], cloud, NONE)
    expect(enqueues).toEqual([])
    expect(unresolved).toEqual([{ ioId: 1, cloudResult: 'Passed', reason: 'timestamp-tie' }])
  })

  it('skips IOs that already have a queue row (active or parked) — the queue owns them', () => {
    const cloud: CloudIoState[] = [{ id: 1, result: 'Passed', timestamp: '2026-07-09T10:00:00.000Z' }]
    const { enqueues, unresolved } = computeClearReenqueues([clearRow({ id: 1 })], cloud, new Set([1]))
    expect(enqueues).toEqual([])
    expect(unresolved).toEqual([])
  })

  it('skips rows whose latest history is NOT a deliberate Cleared (never-tested null)', () => {
    const cloud: CloudIoState[] = [{ id: 1, result: 'Passed', timestamp: '2026-07-09T10:00:00.000Z' }]
    for (const lastResult of [null, 'Passed', 'Comment Added']) {
      const { enqueues, unresolved } = computeClearReenqueues(
        [clearRow({ id: 1, lastResult })], cloud, NONE,
      )
      expect(enqueues).toEqual([])
      expect(unresolved).toEqual([])
    }
  })

  it('skips when the cloud is already clear (converged) or the IO is absent from the payload', () => {
    expect(computeClearReenqueues([clearRow({ id: 1 })], [{ id: 1, result: '' }], NONE).enqueues).toEqual([])
    expect(computeClearReenqueues([clearRow({ id: 1 })], [{ id: 1, result: null }], NONE).enqueues).toEqual([])
    expect(computeClearReenqueues([clearRow({ id: 99 })], [], NONE).enqueues).toEqual([])
  })

  it('handles an ISO clear timestamp and a SQLite-shaped cloud timestamp symmetrically', () => {
    const { enqueues } = computeClearReenqueues(
      [clearRow({ id: 1, clearedAt: '2026-07-10T10:00:00.000Z' })],
      [{ id: 1, result: 'Passed', version: 3, timestamp: '2026-07-09 10:00:00' }],
      NONE,
    )
    expect(enqueues).toHaveLength(1)
    expect(enqueues[0].version).toBe(3)
  })
})

// F9 (2026-07-03 sync audit): FV flavor of the orphan trap — the MCM17 class.
import { computeL2ReconcileEnqueues, type LocalL2CellRow } from '@/lib/cloud/result-reconciler'

const cell = (dev: number, col: number, value: string, updatedBy: string | null = 'kev'): LocalL2CellRow => ({
  deviceCloudId: dev, columnCloudId: col, value, updatedBy,
})
const NOKEYS = new Set<string>()

describe('computeL2ReconcileEnqueues (F9 — FV orphans)', () => {
  it('re-enqueues a cell the cloud payload is missing entirely, with base version 0', () => {
    const out = computeL2ReconcileEnqueues([cell(10, 20, 'Passed')], [], NOKEYS)
    expect(out).toEqual([{ cloudDeviceId: 10, cloudColumnId: 20, value: 'Passed', updatedBy: 'kev', version: 0 }])
  })

  it('re-enqueues when the cloud cell exists but is EMPTY, using the cloud version as base', () => {
    const out = computeL2ReconcileEnqueues(
      [cell(10, 20, 'Passed')],
      [{ deviceId: 10, columnId: 20, value: '', version: 4 }],
      NOKEYS,
    )
    expect(out).toHaveLength(1)
    expect(out[0].version).toBe(4)
  })

  it('does NOT touch a cell the cloud holds a DIFFERENT value for (last-write-wins)', () => {
    const out = computeL2ReconcileEnqueues(
      [cell(10, 20, 'Passed')],
      [{ deviceId: 10, columnId: 20, value: 'Failed', version: 4 }],
      NOKEYS,
    )
    expect(out).toHaveLength(0)
  })

  it('skips cells that already have a queue row (active or parked)', () => {
    const out = computeL2ReconcileEnqueues([cell(10, 20, 'Passed')], [], new Set(['10-20']))
    expect(out).toHaveLength(0)
  })

  it('skips empty local values and handles string cloud ids', () => {
    expect(computeL2ReconcileEnqueues([cell(10, 20, '   ')], [], NOKEYS)).toHaveLength(0)
    expect(computeL2ReconcileEnqueues(
      [cell(10, 20, 'Passed')],
      [{ deviceId: '10', columnId: '20', value: 'Passed', version: 1 }],
      NOKEYS,
    )).toHaveLength(0)
  })
})

// ── Cloud-owned columns must never be re-pushed (belt untrack, 2026-07-22) ──
describe('computeL2ReconcileEnqueues — cloud-owned columns', () => {
  const owned = (value: string, name = 'Belt Tracked'): LocalL2CellRow => ({
    deviceCloudId: 10, columnCloudId: 20, value, updatedBy: 'kev', columnName: name,
  })

  it('does NOT re-enqueue a "Belt Tracked" cell the cloud deliberately CLEARED', () => {
    // Without this the reconciler reads local 'Yes' + cloud '' as "the cloud is
    // missing my work", pushes 'Yes' back UP at the cloud's current version, and
    // silently RE-TRACKS the belt — undoing the pull/SSE clears next cycle.
    expect(computeL2ReconcileEnqueues(
      [owned('Yes')],
      [{ deviceId: 10, columnId: 20, value: '', version: 7 }],
      NOKEYS,
    )).toHaveLength(0)
  })

  it('does NOT re-enqueue a "Belt Tracked" cell the cloud payload omits entirely', () => {
    expect(computeL2ReconcileEnqueues([owned('Yes')], [], NOKEYS)).toHaveLength(0)
  })

  it('matches the cloud-owned column name case-insensitively', () => {
    expect(computeL2ReconcileEnqueues([owned('Yes', 'belt tracked')], [], NOKEYS)).toHaveLength(0)
    expect(computeL2ReconcileEnqueues([owned('Yes', ' BELT TRACKED ')], [], NOKEYS)).toHaveLength(0)
  })

  it('STILL re-enqueues an orphaned FIELD-owned cell (regression guard)', () => {
    expect(computeL2ReconcileEnqueues(
      [owned('Passed', 'Check')],
      [{ deviceId: 10, columnId: 20, value: '', version: 7 }],
      NOKEYS,
    )).toHaveLength(1)
    // and a row with no column name at all is treated as field-owned
    expect(computeL2ReconcileEnqueues([cell(10, 20, 'Passed')], [], NOKEYS)).toHaveLength(1)
  })
})
