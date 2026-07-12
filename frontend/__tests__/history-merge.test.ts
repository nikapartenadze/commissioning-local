import { describe, it, expect } from 'vitest'
import { mergeHistories, type LocalHistoryInput, type CloudHistoryInput } from '@/lib/history-merge'

/**
 * mergeHistories backs the /api/history/:ioId read-time merge that restores
 * cross-tablet Test History visibility (delta-sync stopped carrying
 * TestHistories rows, so local SQLite only sees this machine's actions).
 */

function localRow(over: Partial<LocalHistoryInput> = {}): LocalHistoryInput {
  return {
    id: 1, ioId: 10, result: 'Failed', testedBy: 'Nika',
    timestamp: '2026-07-12T08:00:00.000Z', failureMode: 'Not Installed',
    state: 'OFF', comments: 'device missing', ...over,
  }
}

function cloudRow(over: Partial<CloudHistoryInput> = {}): CloudHistoryInput {
  return {
    id: 501, ioId: 10, result: 'Failed', testedBy: 'Nika',
    timestamp: '2026-07-12T08:00:01.200Z', state: 'OFF', comments: 'device missing', ...over,
  }
}

describe('mergeHistories', () => {
  it('includes cloud-only rows (other tablets / cloud UI actions)', () => {
    const cloud = [cloudRow({ id: 900, result: 'Addressed', testedBy: 'Keith', timestamp: '2026-07-11T10:00:00.000Z' })]
    const out = mergeHistories([localRow()], cloud)
    expect(out).toHaveLength(2)
    const addressed = out.find(r => r.result === 'Addressed')
    expect(addressed).toBeDefined()
    expect(addressed!.source).toBe('cloud')
    expect(addressed!.testedBy).toBe('Keith')
  })

  it('dedups the cloud echo of a local action (same result/user, ms-skewed timestamp)', () => {
    // The local row and its PendingSyncs push are stamped separately, so the
    // cloud copy is ~1s later. Must collapse to ONE row, keeping the local
    // copy (it carries failureMode).
    const out = mergeHistories([localRow()], [cloudRow()])
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('local')
    expect(out[0].failureMode).toBe('Not Installed')
  })

  it('does NOT dedup rows outside the 5s window (two genuine events)', () => {
    const out = mergeHistories(
      [localRow()],
      [cloudRow({ timestamp: '2026-07-12T08:00:30.000Z' })],
    )
    expect(out).toHaveLength(2)
  })

  it('does NOT dedup same-time rows with different results', () => {
    const out = mergeHistories(
      [localRow({ result: 'Failed' })],
      [cloudRow({ result: 'Cleared' })],
    )
    expect(out).toHaveLength(2)
  })

  it('does NOT dedup same-time rows by two different named users', () => {
    const out = mergeHistories(
      [localRow({ testedBy: 'Nika' })],
      [cloudRow({ testedBy: 'Keith' })],
    )
    expect(out).toHaveLength(2)
  })

  it('treats generic testedBy (API/Unknown/empty) as compatible for dedup', () => {
    const out = mergeHistories(
      [localRow({ testedBy: 'Unknown' })],
      [cloudRow({ testedBy: 'Nika' })],
    )
    expect(out).toHaveLength(1)
  })

  it('upgrades a generic local testedBy to the cloud named attribution', () => {
    const out = mergeHistories(
      [localRow({ testedBy: 'Unknown' })],
      [cloudRow({ testedBy: 'Keith' })],
    )
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('local')
    expect(out[0].testedBy).toBe('Keith')
  })

  it('sorts newest-first across sources', () => {
    const out = mergeHistories(
      [localRow({ timestamp: '2026-07-10T00:00:00.000Z' })],
      [cloudRow({ id: 700, result: 'Passed', timestamp: '2026-07-12T00:00:00.000Z' })],
    )
    expect(out[0].result).toBe('Passed')
    expect(out[1].result).toBe('Failed')
  })

  it('keeps rows with unparsable timestamps (audit trail is never dropped) after parsable ones', () => {
    const out = mergeHistories(
      [localRow({ timestamp: 'not-a-date' })],
      [cloudRow({ id: 700, result: 'Passed' })],
    )
    expect(out).toHaveLength(2)
    expect(out[0].result).toBe('Passed')
    expect(out[1].timestamp).toBe('not-a-date')
  })

  it('caps output at the limit', () => {
    const cloud = Array.from({ length: 150 }, (_, i) =>
      cloudRow({ id: 1000 + i, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
    const out = mergeHistories([], cloud, 100)
    expect(out).toHaveLength(100)
  })

  it('works with empty cloud (offline fallback = old behavior)', () => {
    const out = mergeHistories([localRow()], [])
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('local')
  })
})

describe('mergeHistories — subsystem-wide (All Test History) behavior', () => {
  it('does NOT dedup same-result same-time rows on DIFFERENT IOs', () => {
    const out = mergeHistories(
      [localRow({ ioId: 10 })],
      [cloudRow({ ioId: 11 })],
    )
    expect(out).toHaveLength(2)
  })

  it('preserves ioName/ioDescription/subsystemName from cloud rows', () => {
    const out = mergeHistories(
      [],
      [cloudRow({ id: 900, ioName: 'UL17_18:I.In_5', ioDescription: 'Belt PE', subsystemName: 'MCM04' }) as any],
    )
    expect(out).toHaveLength(1)
    const row = out[0] as any
    expect(row.ioName).toBe('UL17_18:I.In_5')
    expect(row.subsystemName).toBe('MCM04')
    expect(row.source).toBe('cloud')
  })

  it('shows synthesized punchlist entries (negative cloud ids) as their own rows', () => {
    const out = mergeHistories(
      [localRow()],
      [cloudRow({ id: -3, result: 'Addressed', testedBy: 'coordinator@lci.ge', timestamp: '2026-07-12T08:00:00.500Z' })],
    )
    // Same 5s window as the local Failed row but different result — distinct.
    expect(out).toHaveLength(2)
    expect(out.find(r => r.result === 'Addressed')!.id).toBe(-3)
  })
})
