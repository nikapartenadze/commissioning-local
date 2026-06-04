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
import { computeAtRiskResults } from '@/lib/cloud/pull-guard'

const local = (id: number, name: string, result: string) => ({ id, Name: name, Result: result })

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
