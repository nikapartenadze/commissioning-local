/**
 * Test: Pull result-loss guard.
 *
 * The destructive manual pull (DELETE FROM Ios + reinsert cloud state) must
 * refuse when local IOs hold results the cloud payload lacks — the exact
 * shape of the 2026-06-04 TPA8/MCM08 incident, where 818 unsynced results
 * were wiped because the pending-queue guard had been blinded by the retry
 * cap. This guard compares actual data, not the queue.
 */
import { describe, it, expect } from 'vitest'
import {
  computeAtRiskResults,
  computeAtRiskComments,
  computeDivergentUnqueuedResults,
  computeAtRiskL2Cells,
  parseDbTimestamp,
} from '@/lib/cloud/pull-guard'

const local = (id: number, name: string, result: string) => ({ id, Name: name, Result: result })
const localC = (id: number, name: string, Comments: string) => ({ id, Name: name, Comments })

describe('computeAtRiskResults', () => {
  it('flags local result when cloud has the IO but no result (the MCM08 shape)', () => {
    const atRisk = computeAtRiskResults(
      [local(89811, 'S02_1_FIOM2_X0.O.0', 'Passed')],
      [{ id: 89811, result: null }],
    )
    expect(atRisk).toEqual([{ id: 89811, name: 'S02_1_FIOM2_X0.O.0', result: 'Passed' }])
  })

  it('flags local result when the IO is missing from the cloud payload entirely', () => {
    const atRisk = computeAtRiskResults(
      [local(1, 'IO_A', 'Failed')],
      [{ id: 2, result: 'Passed' }],
    )
    expect(atRisk).toHaveLength(1)
  })

  it('flags local result when cloud result is empty string', () => {
    const atRisk = computeAtRiskResults([local(1, 'IO_A', 'Passed')], [{ id: 1, result: '' }])
    expect(atRisk).toHaveLength(1)
  })

  it('does NOT flag when cloud has a DIFFERENT result (normal multi-user last-write-wins)', () => {
    const atRisk = computeAtRiskResults([local(1, 'IO_A', 'Passed')], [{ id: 1, result: 'Failed' }])
    expect(atRisk).toHaveLength(0)
  })

  it('does NOT flag when cloud has the same result', () => {
    const atRisk = computeAtRiskResults([local(1, 'IO_A', 'Passed')], [{ id: 1, result: 'Passed' }])
    expect(atRisk).toHaveLength(0)
  })

  it('handles string cloud ids (JSON payloads are not always typed)', () => {
    const atRisk = computeAtRiskResults([local(1, 'IO_A', 'Passed')], [{ id: '1', result: 'Passed' }])
    expect(atRisk).toHaveLength(0)
  })

  it('empty local DB (fresh tablet setup) → nothing at risk', () => {
    const atRisk = computeAtRiskResults([], [{ id: 1, result: null }])
    expect(atRisk).toHaveLength(0)
  })
})

describe('computeAtRiskComments (B2 — pull also wipes comments)', () => {
  it('flags a local comment the cloud lacks', () => {
    const atRisk = computeAtRiskComments(
      [localC(1, 'IO_A', 'mech to fix bracket')],
      [{ id: 1, comments: null }],
    )
    expect(atRisk).toEqual([{ id: 1, name: 'IO_A' }])
  })

  it('flags when the IO is missing from the cloud payload', () => {
    const atRisk = computeAtRiskComments([localC(1, 'IO_A', 'note')], [{ id: 2, comments: 'x' }])
    expect(atRisk).toHaveLength(1)
  })

  it('does NOT flag an empty/whitespace local comment', () => {
    expect(computeAtRiskComments([localC(1, 'IO_A', '   ')], [{ id: 1, comments: null }])).toHaveLength(0)
  })

  it('does NOT flag when the cloud already has a comment (last-write-wins)', () => {
    expect(computeAtRiskComments([localC(1, 'IO_A', 'local note')], [{ id: 1, comments: 'cloud note' }])).toHaveLength(0)
  })
})

describe('computeDivergentUnqueuedResults (F2 — differing-but-unqueued blind spot)', () => {
  const localT = (id: number, name: string, result: string, ts: string | null) =>
    ({ id, Name: name, Result: result, Timestamp: ts })
  const none = new Set<number>()

  it('flags a NEWER local result that differs from a stale cloud value with no queue row (the MCM08 differs-shape)', () => {
    const out = computeDivergentUnqueuedResults(
      [localT(1, 'IO_A', 'Passed', '2026-07-03T10:00:00.000Z')],
      [{ id: 1, result: 'Failed', timestamp: '2026-07-01T08:00:00.000Z' }],
      none,
    )
    expect(out).toEqual([{
      id: 1, name: 'IO_A', localResult: 'Passed', cloudResult: 'Failed',
      localTimestamp: '2026-07-03T10:00:00.000Z', cloudTimestamp: '2026-07-01T08:00:00.000Z',
    }])
  })

  it('flags when the cloud row has NO timestamp (no evidence cloud is newer)', () => {
    const out = computeDivergentUnqueuedResults(
      [localT(1, 'IO_A', 'Passed', '2026-07-03T10:00:00.000Z')],
      [{ id: 1, result: 'Failed', timestamp: null }],
      none,
    )
    expect(out).toHaveLength(1)
  })

  it('does NOT flag when the cloud value is NEWER (normal multi-user last-write-wins)', () => {
    const out = computeDivergentUnqueuedResults(
      [localT(1, 'IO_A', 'Passed', '2026-07-01T08:00:00.000Z')],
      [{ id: 1, result: 'Failed', timestamp: '2026-07-03T10:00:00.000Z' }],
      none,
    )
    expect(out).toHaveLength(0)
  })

  it('does NOT flag when timestamps are equal (cloud echo of the same write)', () => {
    const ts = '2026-07-03T10:00:00.000Z'
    expect(computeDivergentUnqueuedResults(
      [localT(1, 'IO_A', 'Passed', ts)], [{ id: 1, result: 'Failed', timestamp: ts }], none,
    )).toHaveLength(0)
  })

  it('does NOT flag an IO that still has a queue row (the pending block already protects it)', () => {
    const out = computeDivergentUnqueuedResults(
      [localT(1, 'IO_A', 'Passed', '2026-07-03T10:00:00.000Z')],
      [{ id: 1, result: 'Failed', timestamp: '2026-07-01T08:00:00.000Z' }],
      new Set([1]),
    )
    expect(out).toHaveLength(0)
  })

  it('does NOT flag same results, cloud-empty results, or local rows without a timestamp', () => {
    expect(computeDivergentUnqueuedResults(
      [localT(1, 'A', 'Passed', '2026-07-03T10:00:00.000Z')], [{ id: 1, result: 'Passed', timestamp: null }], none,
    )).toHaveLength(0)
    // cloud-empty is computeAtRiskResults' job, not this guard's
    expect(computeDivergentUnqueuedResults(
      [localT(1, 'A', 'Passed', '2026-07-03T10:00:00.000Z')], [{ id: 1, result: null, timestamp: null }], none,
    )).toHaveLength(0)
    // no local timestamp → cannot establish local is newer → don't block
    expect(computeDivergentUnqueuedResults(
      [localT(1, 'A', 'Passed', null)], [{ id: 1, result: 'Failed', timestamp: null }], none,
    )).toHaveLength(0)
  })

  it('handles string cloud ids', () => {
    const out = computeDivergentUnqueuedResults(
      [localT(7, 'A', 'Passed', '2026-07-03T10:00:00.000Z')],
      [{ id: '7', result: 'Failed', timestamp: '2026-07-01T00:00:00.000Z' }],
      none,
    )
    expect(out).toHaveLength(1)
  })
})

describe('parseDbTimestamp', () => {
  it('treats the zone-less SQLite datetime() shape as UTC (not local time)', () => {
    expect(parseDbTimestamp('2026-07-03 10:00:00')).toBe(Date.parse('2026-07-03T10:00:00Z'))
  })
  it('passes ISO strings through', () => {
    expect(parseDbTimestamp('2026-07-03T10:00:00.000Z')).toBe(Date.parse('2026-07-03T10:00:00.000Z'))
  })
  it('returns NaN for null/garbage', () => {
    expect(parseDbTimestamp(null)).toBeNaN()
    expect(parseDbTimestamp('not a date')).toBeNaN()
  })
})

describe('computeAtRiskL2Cells (F5 — destructive FV pull guard)', () => {
  const cell = (dev: number | null, col: number | null, value: string, updatedAt: string | null) => ({
    deviceCloudId: dev, columnCloudId: col, deviceName: dev != null ? `DEV${dev}` : 'LOCAL_DEV',
    columnName: col != null ? `COL${col}` : 'LOCAL_COL', value, updatedAt,
  })
  const none = new Set<string>()

  it('flags a local cell the cloud payload lacks (cloud-missing — the MCM17 FV shape)', () => {
    const out = computeAtRiskL2Cells(
      [cell(10, 20, 'Passed', '2026-07-03 10:00:00')],
      [],
      none,
    )
    expect(out).toHaveLength(1)
    expect(out[0].reason).toBe('cloud-missing')
  })

  it('flags an unmapped cell (no CloudId) — the delete destroys it and the reinsert cannot restore it', () => {
    const out = computeAtRiskL2Cells([cell(null, 20, 'Passed', '2026-07-03 10:00:00')], [], none)
    expect(out).toHaveLength(1)
    expect(out[0].reason).toBe('unmapped')
  })

  it('flags a NEWER local value that differs from a stale cloud value', () => {
    const out = computeAtRiskL2Cells(
      [cell(10, 20, 'Passed', '2026-07-03 10:00:00')],
      [{ deviceId: 10, columnId: 20, value: 'Failed', updatedAt: '2026-07-01T00:00:00.000Z' }],
      none,
    )
    expect(out).toHaveLength(1)
    expect(out[0].reason).toBe('local-newer')
  })

  it('does NOT flag when the cloud value is the same', () => {
    expect(computeAtRiskL2Cells(
      [cell(10, 20, 'Passed', '2026-07-03 10:00:00')],
      [{ deviceId: 10, columnId: 20, value: 'Passed', updatedAt: '2026-01-01T00:00:00Z' }],
      none,
    )).toHaveLength(0)
  })

  it('does NOT flag when the cloud value is NEWER (normal last-write-wins)', () => {
    expect(computeAtRiskL2Cells(
      [cell(10, 20, 'Passed', '2026-07-01 10:00:00')],
      [{ deviceId: 10, columnId: 20, value: 'Failed', updatedAt: '2026-07-03T10:00:00.000Z' }],
      none,
    )).toHaveLength(0)
  })

  it('does NOT flag queued cells (the pending-queue guard blocks those pulls outright)', () => {
    expect(computeAtRiskL2Cells(
      [cell(10, 20, 'Passed', '2026-07-03 10:00:00')],
      [],
      new Set(['10-20']),
    )).toHaveLength(0)
  })

  it('does NOT flag empty/whitespace local values', () => {
    expect(computeAtRiskL2Cells([cell(10, 20, '   ', '2026-07-03 10:00:00')], [], none)).toHaveLength(0)
  })

  it('the SQLite-vs-ISO timestamp skew does not hide a newer local edit', () => {
    // Local wrote at 10:00 UTC (stored zone-less); cloud value stamped 08:00Z.
    // Naive Date.parse in a UTC+4 zone would read local as 06:00Z and skip.
    const out = computeAtRiskL2Cells(
      [cell(10, 20, 'Passed', '2026-07-03 10:00:00')],
      [{ deviceId: 10, columnId: 20, value: 'Failed', updatedAt: '2026-07-03T08:00:00.000Z' }],
      none,
    )
    expect(out).toHaveLength(1)
  })
})
