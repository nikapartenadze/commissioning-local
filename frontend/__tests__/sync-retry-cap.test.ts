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

describe('e-stop / guided-task-state drain strike policy', () => {
  // Models the exact branch the auto-sync e-stop (pushEstopCheckSyncs) and
  // guided-task-state (pushGuidedTaskStateSyncs) drains now take on a non-OK
  // HTTP response: a network-level status DEFERS the row (no strike, batch
  // stops); anything else is a genuine cloud verdict and burns a strike.
  //
  // Before this fix both drains did `resp.ok ? delete : bumpRetry` — a 429 /
  // ≥500 / 401 HTTP RESPONSE (the catch only covered a THROWN fetch) burned a
  // strike toward the park cap, the premature-park data-loss class that landed
  // on SAFETY (e-stop) data.
  const wouldBurnStrike = (httpStatus: number): boolean =>
    !isNetworkLevelFailure({ httpStatus })

  it('429 / 5xx / 401 responses defer without a strike', () => {
    expect(wouldBurnStrike(429)).toBe(false)
    expect(wouldBurnStrike(500)).toBe(false)
    expect(wouldBurnStrike(503)).toBe(false)
    expect(wouldBurnStrike(401)).toBe(false)
  })

  it('genuine 4xx cloud verdicts (400 / 404 / 409) burn a strike toward the cap', () => {
    expect(wouldBurnStrike(400)).toBe(true)
    expect(wouldBurnStrike(404)).toBe(true)
    expect(wouldBurnStrike(409)).toBe(true)
  })
})
