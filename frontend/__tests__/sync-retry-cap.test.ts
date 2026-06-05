/**
 * Test: Retry-cap strike classification.
 *
 * Catches the class of bug behind the 2026-06-04 TPA8/MCM08 incident:
 * 1,740 PendingSync rows were dropped by the 10-strike retry cap while the
 * site had NO internet — every network timeout counted as a strike, so
 * offline work died from the queue in ~100 seconds. The pull guard
 * ("Pull blocked to protect unsynced local data") then saw an empty queue
 * and let a destructive pull wipe 818 results.
 *
 * Rule: a strike may ONLY be counted when the cloud app actually received
 * the payload and answered "no" (e.g. updatedCount=0 / version mismatch).
 * Anything that never got a definitive cloud verdict — offline, DNS
 * failure, fetch timeout, proxy 5xx, auth misconfig — must NOT burn the
 * cap: the row is still good and just needs to wait for connectivity.
 */
import { describe, it, expect } from 'vitest'
import { isNetworkLevelFailure } from '@/lib/cloud/sync-failure-classification'

describe('isNetworkLevelFailure (does NOT burn the retry cap)', () => {
  it('fetch threw (DNS, timeout, conn refused) → network-level', () => {
    expect(isNetworkLevelFailure({ thrown: true })).toBe(true)
  })

  it('offline short-circuit (no HTTP attempt made) → network-level', () => {
    expect(isNetworkLevelFailure({})).toBe(true)
  })

  it('HTTP 401 auth misconfig → network-level (row is fine, config is not)', () => {
    expect(isNetworkLevelFailure({ httpStatus: 401 })).toBe(true)
  })

  it('HTTP 5xx (cloud or proxy down) → network-level', () => {
    expect(isNetworkLevelFailure({ httpStatus: 500 })).toBe(true)
    expect(isNetworkLevelFailure({ httpStatus: 502 })).toBe(true)
    expect(isNetworkLevelFailure({ httpStatus: 504 })).toBe(true)
  })

  it('HTTP 200 with cloud verdict (updatedCount=0) → counts as a strike', () => {
    expect(isNetworkLevelFailure({ httpStatus: 200 })).toBe(false)
  })

  it('HTTP 4xx other than 401/429 → cloud verdict (handled as permanent elsewhere)', () => {
    expect(isNetworkLevelFailure({ httpStatus: 400 })).toBe(false)
    expect(isNetworkLevelFailure({ httpStatus: 409 })).toBe(false)
  })

  it('HTTP 429 (rate limited) → transient, must NOT burn the retry cap (B1, MCM11)', () => {
    // The cloud rate-limits push at 300/min/key; a flaky link's retry flood
    // trips it. Before the fix, 429 was classed permanent and the result was
    // DELETED on first throttle — silent field-data loss. Reproduced in the
    // battle env (suspect_silent_drops, reason="HTTP 429").
    expect(isNetworkLevelFailure({ httpStatus: 429 })).toBe(true)
  })
})
