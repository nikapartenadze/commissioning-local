/**
 * sync-diff: the version-aware local↔cloud classifier behind the Sync Center
 * Compare view. Locks the exact rule for each divergence + its recommended action.
 */
import { describe, it, expect } from 'vitest'
import { classifyIo, computeSyncDiff, normResult } from '@/lib/sync/sync-diff'
import type { LocalResultRow } from '@/lib/cloud/result-reconciler'

const local = (over: Partial<LocalResultRow & { Name: string }> = {}): LocalResultRow & { Name: string } => ({
  id: 1, Name: 'IO', Result: 'Passed', Comments: null, TestedBy: 'tech', Timestamp: '2026-07-16T12:00:00Z',
  Version: 1, Trade: null, FailureMode: null, ...over,
})

describe('normResult', () => {
  it('treats null/blank/Cleared as empty', () => {
    expect(normResult(null)).toBe('')
    expect(normResult('  ')).toBe('')
    expect(normResult('Cleared')).toBe('')
    expect(normResult('cleared')).toBe('')
    expect(normResult('Passed')).toBe('Passed')
  })
})

describe('classifyIo', () => {
  it('local has a result, cloud has the IO but no result → local_only / push', () => {
    const r = classifyIo(1, 'IO', local(), { id: 1, result: null, version: 0 })
    expect(r.classification).toBe('local_only')
    expect(r.action).toBe('push')
  })

  it('IO absent from cloud entirely + local result → gone_on_cloud / tombstone', () => {
    const r = classifyIo(1, 'IO', local(), undefined)
    expect(r.classification).toBe('gone_on_cloud')
    expect(r.action).toBe('tombstone')
  })

  it('both differ, local version higher → local_newer / push', () => {
    const r = classifyIo(1, 'IO', local({ Result: 'Failed', Version: 3 }), { id: 1, result: 'Passed', version: 2 })
    expect(r.classification).toBe('local_newer')
    expect(r.action).toBe('push')
  })

  it('both differ, cloud version higher → cloud_newer / accept_cloud (stale local)', () => {
    const r = classifyIo(1, 'IO', local({ Result: 'Passed', Version: 1 }), { id: 1, result: 'Failed', version: 5 })
    expect(r.classification).toBe('cloud_newer')
    expect(r.action).toBe('accept_cloud')
  })

  it('cloud has a result, local empty → cloud_only / pull', () => {
    const r = classifyIo(1, 'IO', local({ Result: null }), { id: 1, result: 'Passed', version: 1 })
    expect(r.classification).toBe('cloud_only')
    expect(r.action).toBe('pull')
  })

  it('equal normalized values → in_sync (Cleared vs empty)', () => {
    const r = classifyIo(1, 'IO', local({ Result: 'Cleared', Version: 2 }), { id: 1, result: null, version: 2 })
    expect(r.classification).toBe('in_sync')
  })

  it('same version, different value, no timestamp tiebreak → conflict', () => {
    const r = classifyIo(1, 'IO', local({ Result: 'Passed', Version: 2, Timestamp: null }), { id: 1, result: 'Failed', version: 2 })
    expect(r.classification).toBe('conflict')
    expect(r.action).toBe('none')
  })
})

describe('computeSyncDiff', () => {
  it('summarizes and returns only actionable (non in_sync) rows', () => {
    const localRows = [
      local({ id: 1, Result: 'Passed', Version: 1, Name: 'A' }),          // local_only (cloud empty)
      local({ id: 2, Result: 'Failed', Version: 3, Name: 'B' }),          // local_newer
      local({ id: 3, Result: 'Passed', Version: 1, Name: 'C' }),          // cloud_newer (stale)
      local({ id: 4, Result: 'Passed', Version: 1, Name: 'D' }),          // gone_on_cloud
      local({ id: 5, Result: 'Passed', Version: 2, Name: 'E' }),          // in_sync
    ]
    const cloud = [
      { id: 1, result: null, version: 0 },
      { id: 2, result: 'Passed', version: 2 },
      { id: 3, result: 'Failed', version: 9 },
      // id 4 absent → gone
      { id: 5, result: 'Passed', version: 2 },
      { id: 6, result: 'Passed', version: 1, name: 'F' },                 // cloud_only
    ]
    const { rows, summary } = computeSyncDiff(localRows, cloud)
    expect(summary.push).toBe(2)         // 1 + 2
    expect(summary.acceptCloud).toBe(1)  // 3
    expect(summary.tombstone).toBe(1)    // 4
    expect(summary.pull).toBe(1)         // 6
    expect(summary.inSync).toBe(1)       // 5
    expect(rows.find(r => r.id === 5)).toBeUndefined() // in_sync excluded from rows
    expect(rows.find(r => r.id === 2)!.action).toBe('push')
    expect(rows.find(r => r.id === 3)!.action).toBe('accept_cloud')
  })
})
