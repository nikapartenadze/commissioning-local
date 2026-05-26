import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isNonTerminalUpdateStatus,
  isStaleUpdate,
  computeEffectiveUpdateState,
  computeBootReconciliation,
  type LocalUpdateState,
} from '@/lib/update/update-utils'

describe('update version comparison', () => {
  it('detects newer semantic versions', () => {
    expect(compareVersions('2.10.1', '2.10.0')).toBe(1)
    expect(compareVersions('2.11.0', '2.10.9')).toBe(1)
  })

  it('detects older semantic versions', () => {
    expect(compareVersions('2.10.0', '2.10.1')).toBe(-1)
    expect(compareVersions('2.9.9', '2.10.0')).toBe(-1)
  })

  it('treats equivalent versions as equal', () => {
    expect(compareVersions('v2.10.0', '2.10.0')).toBe(0)
    expect(compareVersions('2.10', '2.10.0')).toBe(0)
  })
})

// Helpers for the stuck-state tests below.
const NOW = Date.parse('2026-05-26T12:00:00.000Z')
const minsAgo = (n: number) => new Date(NOW - n * 60_000).toISOString()
const state = (over: Partial<LocalUpdateState>): LocalUpdateState => ({
  status: 'checking',
  version: '2.39.4',
  startedAt: minsAgo(1),
  ...over,
})

describe('isNonTerminalUpdateStatus', () => {
  it('classifies in-progress statuses', () => {
    for (const s of ['checking', 'downloading', 'installing', 'restarting']) {
      expect(isNonTerminalUpdateStatus(s)).toBe(true)
    }
  })
  it('classifies terminal statuses', () => {
    for (const s of ['idle', 'success', 'error']) {
      expect(isNonTerminalUpdateStatus(s)).toBe(false)
    }
  })
})

describe('isStaleUpdate', () => {
  it('is false for a fresh in-progress update', () => {
    expect(isStaleUpdate(state({ startedAt: minsAgo(2) }), NOW)).toBe(false)
  })

  it('is true for an in-progress update older than the window', () => {
    expect(isStaleUpdate(state({ startedAt: minsAgo(20) }), NOW)).toBe(true)
  })

  it('is false for terminal states regardless of age', () => {
    expect(isStaleUpdate(state({ status: 'success', startedAt: minsAgo(999) }), NOW)).toBe(false)
    expect(isStaleUpdate(state({ status: 'error', startedAt: minsAgo(999) }), NOW)).toBe(false)
  })

  it('treats a missing/unparseable startedAt as stale (can not prove it is live)', () => {
    expect(isStaleUpdate(state({ startedAt: undefined }), NOW)).toBe(true)
    expect(isStaleUpdate(state({ startedAt: 'not-a-date' }), NOW)).toBe(true)
  })

  it('handles null', () => {
    expect(isStaleUpdate(null, NOW)).toBe(false)
  })
})

describe('computeEffectiveUpdateState', () => {
  it('passes through a fresh in-progress state unchanged', () => {
    const s = state({ startedAt: minsAgo(2) })
    expect(computeEffectiveUpdateState(s, NOW)).toBe(s)
  })

  it('downgrades a stale in-progress state to error', () => {
    const out = computeEffectiveUpdateState(state({ status: 'installing', startedAt: minsAgo(30) }), NOW)
    expect(out?.status).toBe('error')
    expect(out?.message).toMatch(/did not complete/i)
    expect(out?.completedAt).toBe(new Date(NOW).toISOString())
  })

  it('leaves terminal states alone', () => {
    const s = state({ status: 'success', startedAt: minsAgo(99) })
    expect(computeEffectiveUpdateState(s, NOW)).toBe(s)
  })

  it('handles null', () => {
    expect(computeEffectiveUpdateState(null, NOW)).toBeNull()
  })
})

describe('computeBootReconciliation', () => {
  it('no-ops on a terminal state', () => {
    expect(computeBootReconciliation(state({ status: 'success' }), '2.39.4', NOW)).toBeNull()
    expect(computeBootReconciliation(state({ status: 'error' }), '2.39.3', NOW)).toBeNull()
  })

  it('no-ops when there is no state', () => {
    expect(computeBootReconciliation(null, '2.39.4', NOW)).toBeNull()
  })

  it('marks success when booted on the target version (install landed)', () => {
    const out = computeBootReconciliation(state({ status: 'restarting', version: '2.39.4' }), '2.39.4', NOW)
    expect(out?.status).toBe('success')
    expect(out?.message).toMatch(/2\.39\.4/)
  })

  it('marks success when booted PAST the target version', () => {
    const out = computeBootReconciliation(state({ status: 'installing', version: '2.39.4' }), '2.40.0', NOW)
    expect(out?.status).toBe('success')
  })

  it('marks error when still on the old version (updater died mid-flight)', () => {
    const out = computeBootReconciliation(state({ status: 'installing', version: '2.39.4' }), '2.39.3', NOW)
    expect(out?.status).toBe('error')
    expect(out?.message).toMatch(/interrupted/i)
    expect(out?.message).toMatch(/2\.39\.3/)
  })
})
