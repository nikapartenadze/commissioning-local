/**
 * Sync Center — HONEST per-row DISPLAY verdict (displayVerdict).
 *
 * The bug this pins: a row that fails every retry for 24 h once read
 * "Sending… · Temporary network issue · Nothing to do — this sends itself once
 * the connection recovers." That is a lie after minutes, let alone a day. And a
 * 403 (the tablet's cloud key doesn't match the project) rode the same benign
 * bucket, when in truth a human must fix the key — it never self-heals.
 *
 * displayVerdict folds STATUS + AGE + LastError into what the operator is
 * actually told, WITHOUT changing retry behaviour (the row keeps retrying
 * forever — only the words escalate):
 *   - active & fresh (< STALE_AFTER_MIN)  → 'sending'   (no action)
 *   - active & stale (≥ STALE_AFTER_MIN)  → 'attention' (check the connection)
 *   - LastError 401/403 (any age)         → 'auth'      (fix the key — a human's job)
 *   - parked / orphaned / resolved        → existing behaviour
 */
import { describe, it, expect } from 'vitest'
import {
  displayVerdict,
  formatDuration,
  STALE_AFTER_MIN,
  REASONS,
  type DisplayRow,
} from '@/lib/sync/queue-inspector'

/** A fresh ACTIVE row (pending), default 2 min old, no error. */
function activeRow(over: Partial<DisplayRow> = {}): DisplayRow {
  return { status: 'pending', lastError: null, retryCount: 0, ageMinutes: 2, ...over }
}

describe('displayVerdict — active rows escalate by age (the 24h lie)', () => {
  it('active & fresh (< STALE_AFTER_MIN) → sending, no action', () => {
    const v = displayVerdict(activeRow({ ageMinutes: STALE_AFTER_MIN - 1 }))
    expect(v.tone).toBe('sending')
    expect(v.needsAction).toBe(false)
    expect(v.headline).toMatch(/sending/i)
    expect(v.detail).toMatch(/on its way|no action/i)
  })

  it('active & 0 min → sending', () => {
    expect(displayVerdict(activeRow({ ageMinutes: 0 })).tone).toBe('sending')
  })

  it('active & stale (== STALE_AFTER_MIN) → attention, and NEVER "temporary/nothing to do"', () => {
    const v = displayVerdict(activeRow({ ageMinutes: STALE_AFTER_MIN }))
    expect(v.tone).toBe('attention')
    expect(v.needsAction).toBe(true)
    expect(v.headline).toMatch(/not reaching the cloud/i)
    // The crux: the old benign phrasing must be gone.
    expect(v.detail).not.toMatch(/nothing to do/i)
    expect(v.detail).not.toMatch(/temporary/i)
    expect(v.detail).not.toMatch(/sends itself/i)
    // …and it names how long it has been stuck, so the escalation is legible.
    expect(v.detail).toMatch(/retrying for/i)
  })

  it('active & stale for 24h → attention with a "1d" duration, still not benign', () => {
    const v = displayVerdict(activeRow({ ageMinutes: 24 * 60 }))
    expect(v.tone).toBe('attention')
    expect(v.detail).toContain('1d')
    expect(v.detail).not.toMatch(/nothing to do/i)
  })

  it('derives age from createdAt when ageMinutes is absent', () => {
    const oldIso = new Date(Date.now() - 3 * 60 * 60_000).toISOString() // 3h ago
    const v = displayVerdict({ status: 'pending', lastError: null, createdAt: oldIso })
    expect(v.tone).toBe('attention')
    expect(v.detail).toContain('3h')
  })
})

describe('displayVerdict — 401/403 is an AUTH verdict at ANY age', () => {
  const authErrors = ['HTTP 403', 'HTTP 403 (network-level, no strike)', 'HTTP 401 auth failed', 'forbidden — wrong project']

  it('reads as auth even when the row is brand new (fresh)', () => {
    for (const e of authErrors) {
      const v = displayVerdict(activeRow({ ageMinutes: 0, lastError: e }))
      expect(v.tone, e).toBe('auth')
      expect(v.needsAction, e).toBe(true)
    }
  })

  it('reads as auth even after 24h (never decays into "attention" or "sending")', () => {
    const v = displayVerdict(activeRow({ ageMinutes: 24 * 60, lastError: 'HTTP 403' }))
    expect(v.tone).toBe('auth')
    expect(v.needsAction).toBe(true)
    // Headline is plain (no raw code); the raw HTTP code is allowed in the detail.
    expect(v.headline).not.toMatch(/40\d/)
    expect(v.headline).toMatch(/key/i)
    expect(v.detail).toMatch(/HTTP 403/)
    expect(v.detail).toMatch(/settings/i)
    expect(v.detail).toMatch(/safe/i)
    // Not the benign network wording.
    expect(v.detail).not.toMatch(/nothing to do|temporary|sends itself/i)
  })

  it('surfaces the actual status (401 vs 403) in the detail', () => {
    expect(displayVerdict(activeRow({ lastError: 'HTTP 401 auth failed' })).detail).toMatch(/HTTP 401/)
    expect(displayVerdict(activeRow({ lastError: 'HTTP 403' })).detail).toMatch(/HTTP 403/)
  })

  it('honours an explicit auth_error classification too', () => {
    const v = displayVerdict({ status: 'pending', classification: 'auth_error', ageMinutes: 5 })
    expect(v.tone).toBe('auth')
    expect(v.needsAction).toBe(true)
  })
})

describe('displayVerdict — parked / orphaned / resolved keep their existing behaviour', () => {
  it('resolved → resolved, nothing to do', () => {
    const v = displayVerdict({ status: 'resolved', lastError: 'HTTP 410', ageMinutes: 100 })
    expect(v.tone).toBe('resolved')
    expect(v.needsAction).toBe(false)
    expect(v.headline).toMatch(/cleared automatically/i)
  })

  it('orphaned → gone, self-heals, nothing to do', () => {
    const v = displayVerdict({ status: 'orphaned', lastError: 'HTTP 404', ageMinutes: 100 })
    expect(v.tone).toBe('gone')
    expect(v.needsAction).toBe(false)
    expect(v.headline).toMatch(/removed on cloud/i)
  })

  it('parked gone_on_cloud (404) → gone', () => {
    const v = displayVerdict({ status: 'parked', lastError: 'HTTP 404', ageMinutes: 100 })
    expect(v.tone).toBe('gone')
    expect(v.needsAction).toBe(false)
  })

  it('parked cloud_rejected → attention, needs a human, plain reason (no raw text)', () => {
    const v = displayVerdict({ status: 'parked', lastError: 'HTTP 422 invalid value', ageMinutes: 100 })
    expect(v.tone).toBe('attention')
    expect(v.needsAction).toBe(true)
    expect(v.headline).toMatch(/would not accept/i)
    expect(v.detail).toBe(REASONS.cloud_rejected) // canonical, no "(Cloud said: …)" raw
  })

  it('parked version_conflict → attention', () => {
    const v = displayVerdict({ status: 'parked', lastError: 'HTTP 409 conflict', ageMinutes: 100 })
    expect(v.tone).toBe('attention')
    expect(v.headline).toMatch(/newer value/i)
  })

  it('a PARKED 403 still reads as auth (auth beats parked)', () => {
    const v = displayVerdict({ status: 'parked', lastError: 'HTTP 403', ageMinutes: 100 })
    expect(v.tone).toBe('auth')
    expect(v.needsAction).toBe(true)
  })
})

describe('formatDuration', () => {
  it('formats minutes / hours / days as one rounded unit', () => {
    expect(formatDuration(0)).toBe('under a minute')
    expect(formatDuration(12)).toBe('12m')
    expect(formatDuration(59)).toBe('59m')
    expect(formatDuration(60)).toBe('1h')
    expect(formatDuration(90)).toBe('2h')       // rounds
    expect(formatDuration(23 * 60)).toBe('23h')
    expect(formatDuration(24 * 60)).toBe('1d')
    expect(formatDuration(2 * 24 * 60)).toBe('2d')
  })

  it('degrades to "a while" for an unknown age', () => {
    expect(formatDuration(null)).toBe('a while')
    expect(formatDuration(undefined)).toBe('a while')
  })
})
