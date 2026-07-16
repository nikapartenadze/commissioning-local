import { describe, it, expect } from 'vitest'
import { isDefinitiveMissingTagStatus } from '@/lib/vfd-validation-writer'
import { PlcTagStatus } from '@/lib/plc'

/**
 * Regression guard (MCM04 forensics 2026-07-16): a belt-tracking CMD member
 * absent from the AOI (e.g. Tracking_Finished) answers BAD_PARAM, not NOT_FOUND,
 * so it escaped knownMissingTags and re-spammed createTag every validation pass
 * (thousands of doomed CIP calls/day). BAD_PARAM/UNSUPPORTED must now cache too.
 */
describe('isDefinitiveMissingTagStatus', () => {
  it('caches BAD_PARAM (the Tracking_Finished firehose) as definitively missing', () => {
    expect(isDefinitiveMissingTagStatus(PlcTagStatus.PLCTAG_ERR_BAD_PARAM)).toBe(true)
  })

  it('caches NOT_FOUND and UNSUPPORTED too', () => {
    expect(isDefinitiveMissingTagStatus(PlcTagStatus.PLCTAG_ERR_NOT_FOUND)).toBe(true)
    expect(isDefinitiveMissingTagStatus(PlcTagStatus.PLCTAG_ERR_UNSUPPORTED)).toBe(true)
  })

  it('does NOT cache transient failures (timeout/busy must retry)', () => {
    expect(isDefinitiveMissingTagStatus(PlcTagStatus.PLCTAG_ERR_TIMEOUT)).toBe(false)
    expect(isDefinitiveMissingTagStatus(PlcTagStatus.PLCTAG_STATUS_OK)).toBe(false)
  })
})
