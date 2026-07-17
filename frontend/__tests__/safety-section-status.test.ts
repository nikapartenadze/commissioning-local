/**
 * Safety list section status — a FAILED fetch must not render as "none configured".
 */
import { describe, it, expect } from 'vitest'
import { safetySectionStatus } from '@/lib/safety-section-status'

describe('safetySectionStatus', () => {
  it('loading wins over everything', () => {
    expect(safetySectionStatus(true, true, 0)).toBe('loading')
    expect(safetySectionStatus(true, false, 5)).toBe('loading')
  })

  it('THE FIX: error wins over empty — a failed fetch is never "empty/none configured"', () => {
    expect(safetySectionStatus(false, true, 0)).toBe('error')
    expect(safetySectionStatus(false, true, 3)).toBe('error') // even if a stale count exists
  })

  it('empty only when NOT loading, NOT error, and count is 0', () => {
    expect(safetySectionStatus(false, false, 0)).toBe('empty')
  })

  it('ready when there are items', () => {
    expect(safetySectionStatus(false, false, 1)).toBe('ready')
    expect(safetySectionStatus(false, false, 12)).toBe('ready')
  })
})
