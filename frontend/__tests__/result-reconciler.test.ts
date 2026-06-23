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
