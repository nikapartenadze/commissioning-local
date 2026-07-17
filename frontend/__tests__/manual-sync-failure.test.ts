/**
 * Manual "Sync L2 now" must not burn a retry strike on network-level failures
 * (the 2026-06-04 data-loss class) — only a genuine cloud verdict (non-network
 * 4xx) counts toward the park cap.
 */
import { describe, it, expect } from 'vitest'
import { manualSyncFailureUpdate } from '@/lib/cloud/manual-sync-failure'

describe('manualSyncFailureUpdate', () => {
  it('NO strike on network-level failures (thrown / 401 / 429 / 5xx)', () => {
    expect(manualSyncFailureUpdate({ thrown: true, message: 'ECONNRESET' })).toMatchObject({ strike: false, lastError: 'network: ECONNRESET' })
    expect(manualSyncFailureUpdate({ httpStatus: 401 }).strike).toBe(false)
    expect(manualSyncFailureUpdate({ httpStatus: 429 }).strike).toBe(false)
    expect(manualSyncFailureUpdate({ httpStatus: 500 }).strike).toBe(false)
    expect(manualSyncFailureUpdate({ httpStatus: 503 }).strike).toBe(false)
  })

  it('network-level HTTP failures label themselves so the operator sees "no strike"', () => {
    expect(manualSyncFailureUpdate({ httpStatus: 429 }).lastError).toBe('HTTP 429 (network-level, no strike)')
  })

  it('STRIKE on a genuine cloud verdict (non-network 4xx)', () => {
    expect(manualSyncFailureUpdate({ httpStatus: 400 }).strike).toBe(true)
    expect(manualSyncFailureUpdate({ httpStatus: 404 }).strike).toBe(true)
    expect(manualSyncFailureUpdate({ httpStatus: 409 }).strike).toBe(true)
    expect(manualSyncFailureUpdate({ httpStatus: 422 }).strike).toBe(true)
    expect(manualSyncFailureUpdate({ httpStatus: 400 }).lastError).toBe('HTTP 400')
  })
})
