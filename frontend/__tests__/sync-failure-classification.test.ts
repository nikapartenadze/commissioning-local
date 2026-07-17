/**
 * Sync-failure classification — the boundary that decides whether a failed cloud
 * push is TRANSIENT (retry, no strike, no tombstone), a PERMANENT REMOVAL (the
 * cloud target is gone → park/orphan), or a plain cloud verdict (strike → park).
 *
 * Regression pin for the 2026-07-17 data-loss finding: HTTP 403 was classed as a
 * PERMANENT REMOVAL, so a push that got 403 fired orphan() → Ios.CloudRemoved=1,
 * tombstoning genuinely-unsynced local work and DISARMING the pull-guard (which
 * excludes CloudRemoved rows). But the cloud returns 403 for AUTH / PROJECT-KEY
 * MISMATCH (validateApiKeyForIo fail in app/api/sync/update/route.ts), i.e. a
 * config problem on the tool — the SAME category as 401 — NOT a verdict that the
 * record was removed. So 403 must be TRANSIENT (retry, self-heal on config fix),
 * never a removal. Genuine record-removal on that route is a 200-body
 * `rejected:[{permanent:true}]`, and 404/410 remain true removals.
 */
import { describe, it, expect } from 'vitest'
import {
  isNetworkLevelFailure,
  isPermanentRejectionStatus,
} from '@/lib/cloud/sync-failure-classification'

describe('isNetworkLevelFailure — transient, no strike, no tombstone', () => {
  it('403 is TRANSIENT (auth/project-key mismatch — same category as 401)', () => {
    // THE FIX: a 403 must never be treated as a record-removal verdict.
    expect(isNetworkLevelFailure({ httpStatus: 403 })).toBe(true)
  })

  it('keeps the existing transient set (thrown / no-attempt / 401 / 429 / 5xx)', () => {
    expect(isNetworkLevelFailure({ thrown: true })).toBe(true)
    expect(isNetworkLevelFailure({ httpStatus: undefined })).toBe(true)
    expect(isNetworkLevelFailure({ httpStatus: 401 })).toBe(true)
    expect(isNetworkLevelFailure({ httpStatus: 429 })).toBe(true)
    expect(isNetworkLevelFailure({ httpStatus: 500 })).toBe(true)
    expect(isNetworkLevelFailure({ httpStatus: 503 })).toBe(true)
  })

  it('a plain cloud verdict (400 / 409 / 410 / 422 / 404) is NOT network-level', () => {
    expect(isNetworkLevelFailure({ httpStatus: 400 })).toBe(false)
    expect(isNetworkLevelFailure({ httpStatus: 409 })).toBe(false)
    expect(isNetworkLevelFailure({ httpStatus: 410 })).toBe(false)
    expect(isNetworkLevelFailure({ httpStatus: 422 })).toBe(false)
    expect(isNetworkLevelFailure({ httpStatus: 404 })).toBe(false)
  })
})

describe('isPermanentRejectionStatus — confirmed cloud removal only', () => {
  it('403 is NOT a permanent removal (it is auth/config, handled as transient)', () => {
    // THE FIX: removing 403 here stops parsePermanentRemovalStatus from routing
    // a 403 into orphan()/CloudRemoved.
    expect(isPermanentRejectionStatus(403)).toBe(false)
  })

  it('404 and 410 ARE permanent removals (target gone → tombstone is correct)', () => {
    expect(isPermanentRejectionStatus(404)).toBe(true)
    expect(isPermanentRejectionStatus(410)).toBe(true)
  })

  it('transient / verdict statuses are not permanent removals', () => {
    expect(isPermanentRejectionStatus(400)).toBe(false)
    expect(isPermanentRejectionStatus(401)).toBe(false)
    expect(isPermanentRejectionStatus(409)).toBe(false)
    expect(isPermanentRejectionStatus(422)).toBe(false)
    expect(isPermanentRejectionStatus(429)).toBe(false)
    expect(isPermanentRejectionStatus(500)).toBe(false)
    expect(isPermanentRejectionStatus(undefined)).toBe(false)
  })
})

describe('disjointness — a status is never BOTH transient and a permanent removal', () => {
  it('no status is classified as both network-level and permanent-removal', () => {
    for (const s of [400, 401, 403, 404, 409, 410, 422, 429, 500, 503]) {
      expect(isNetworkLevelFailure({ httpStatus: s }) && isPermanentRejectionStatus(s)).toBe(false)
    }
  })
})
