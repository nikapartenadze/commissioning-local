/**
 * Safety bypass confirmation — fail-safe: only a 2xx + success:true counts.
 * Everything else (503/500 with success:false, missing/garbage body, network
 * throw handled by the caller) must be treated as NOT confirmed, so the UI never
 * claims a bypass state the controller didn't actually reach.
 */
import { describe, it, expect } from 'vitest'
import { bypassConfirmed } from '@/lib/bypass-response'

describe('bypassConfirmed', () => {
  it('confirmed only on 2xx AND success:true', () => {
    expect(bypassConfirmed(true, { success: true })).toBe(true)
  })

  it('NOT confirmed on a non-2xx even if body somehow says success', () => {
    expect(bypassConfirmed(false, { success: true })).toBe(false)
  })

  it('NOT confirmed when the body says success:false (503 PLC-not-connected / 500 write-failed)', () => {
    expect(bypassConfirmed(true, { success: false })).toBe(false)
    expect(bypassConfirmed(false, { success: false })).toBe(false)
  })

  it('NOT confirmed on missing/garbage body', () => {
    expect(bypassConfirmed(true, null)).toBe(false)
    expect(bypassConfirmed(true, undefined)).toBe(false)
    expect(bypassConfirmed(true, {})).toBe(false)
    expect(bypassConfirmed(true, { success: 'true' })).toBe(false) // string, not boolean true
    expect(bypassConfirmed(true, { success: 1 })).toBe(false)
  })
})
