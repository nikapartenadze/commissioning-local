/**
 * Durable client-side FV/L2 cell outbox — the fix for the "some cells saved,
 * some not, after reload" data loss. Every edit is persisted to a durable store
 * BEFORE the POST, retried on transient failure, and only removed once the
 * server confirms it. A reload replays whatever never confirmed.
 *
 * Pure logic with injected storage + fetch (node env, no DOM), mirroring the
 * behaviours the real fv-validation-view save path must guarantee.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveL2Cell, replayL2Outbox, pendingCount, type OutboxDeps } from '@/lib/l2-outbox'

// In-memory Storage double.
function makeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    _dump: () => m,
  }
}

function ok(body: any = { success: true }) {
  return { ok: true, status: 200, json: async () => body }
}
function httpErr(status: number) {
  return { ok: false, status, json: async () => ({ error: `HTTP ${status}` }) }
}

let storage: ReturnType<typeof makeStorage>
function deps(fetchFn: any): OutboxDeps {
  return { storage, fetchFn, now: () => 1000, sleep: async () => {} }
}
const edit = (over: Partial<{ deviceId: number; columnId: number; value: string | null; updatedBy: string; ts: number }> = {}) =>
  ({ deviceId: 1, columnId: 2, value: 'Forward', updatedBy: 'tech@x', ts: 5, ...over })

beforeEach(() => { storage = makeStorage() })

describe('saveL2Cell — durable, confirmed, retried', () => {
  it('on a confirmed save, resolves ok and leaves NOTHING in the outbox', async () => {
    const fetchFn = vi.fn(async () => ok())
    const r = await saveL2Cell(edit(), deps(fetchFn))
    expect(r.ok).toBe(true)
    expect(pendingCount(storage)).toBe(0)
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('on a failed save, reports ok:false AND keeps the edit durably in the outbox for replay', async () => {
    const fetchFn = vi.fn(async () => httpErr(500))
    const r = await saveL2Cell(edit(), deps(fetchFn))
    expect(r.ok).toBe(false)
    expect(pendingCount(storage)).toBe(1) // survives — a reload can replay it
  })

  it('retries a transient 500 and succeeds without user action (self-heals)', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => { n++; return n < 3 ? httpErr(500) : ok() })
    const r = await saveL2Cell(edit(), deps(fetchFn))
    expect(r.ok).toBe(true)
    expect(n).toBe(3)
    expect(pendingCount(storage)).toBe(0)
  })

  it('does NOT waste retries on a permanent 400 — fails fast but keeps the edit', async () => {
    const fetchFn = vi.fn(async () => httpErr(400))
    const r = await saveL2Cell(edit(), deps(fetchFn))
    expect(r.ok).toBe(false)
    expect(fetchFn).toHaveBeenCalledOnce() // no pointless retries on a 4xx
    expect(pendingCount(storage)).toBe(1)
  })

  it('treats a thrown fetch (network/timeout) as a retriable failure, edit preserved', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network down') })
    const r = await saveL2Cell(edit(), deps(fetchFn))
    expect(r.ok).toBe(false)
    expect(pendingCount(storage)).toBe(1)
  })

  it('a newer edit for the same cell overwrites the older queued value (last value wins)', async () => {
    const fetchFn = vi.fn(async () => httpErr(500))
    await saveL2Cell(edit({ value: 'Forward', ts: 5 }), deps(fetchFn))
    await saveL2Cell(edit({ value: 'Reverse', ts: 6 }), deps(fetchFn))
    expect(pendingCount(storage)).toBe(1) // still one cell, not two rows
    const stored = JSON.parse(storage.getItem('l2-cell-outbox-v1')!)
    expect(stored['1:2'].value).toBe('Reverse')
  })
})

describe('durability signalling and bounded replay', () => {
  it('reports queued:false (and does not claim durability) when the store throws (quota)', async () => {
    const throwingStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
    }
    const r = await saveL2Cell(edit(), { storage: throwingStorage as any, fetchFn: vi.fn(async () => httpErr(500)), sleep: async () => {} })
    // The POST failed and the edit could NOT be persisted — that must be visible,
    // never a silent success.
    expect(r.ok).toBe(false)
    expect(r.queued).toBe(false)
  })

  it('reports queued:true on a normal failure (edit is durably held for replay)', async () => {
    const r = await saveL2Cell(edit(), deps(vi.fn(async () => httpErr(500))))
    expect(r.ok).toBe(false)
    expect(r.queued).toBe(true)
    expect(pendingCount(storage)).toBe(1)
  })

  it('evicts an edit that keeps failing on replay so it cannot loop forever', async () => {
    // Queue a permanently-failing edit.
    await saveL2Cell(edit(), deps(vi.fn(async () => httpErr(400))))
    expect(pendingCount(storage)).toBe(1)
    // Replay it enough times that it exceeds the bounded attempt cap.
    let evictedTotal = 0
    for (let i = 0; i < 10 && pendingCount(storage) > 0; i++) {
      const res = await replayL2Outbox(deps(vi.fn(async () => httpErr(400))))
      evictedTotal += res.evicted
    }
    expect(pendingCount(storage)).toBe(0) // no longer loops forever
    expect(evictedTotal).toBe(1)
  })
})

describe('replayL2Outbox — reload recovery', () => {
  it('re-sends queued edits and clears the ones the server now accepts', async () => {
    // Two edits fail to save (offline), so both sit in the outbox.
    await saveL2Cell(edit({ deviceId: 1, columnId: 2, ts: 5 }), deps(vi.fn(async () => httpErr(503))))
    await saveL2Cell(edit({ deviceId: 3, columnId: 4, ts: 6 }), deps(vi.fn(async () => httpErr(503))))
    expect(pendingCount(storage)).toBe(2)

    // Connectivity returns; replay drains the outbox.
    const res = await replayL2Outbox(deps(vi.fn(async () => ok())))
    expect(res.replayed).toBe(2)
    expect(res.remaining).toBe(0)
    expect(pendingCount(storage)).toBe(0)
  })

  it('keeps edits that still fail on replay (so they are not lost)', async () => {
    await saveL2Cell(edit({ deviceId: 1, columnId: 2 }), deps(vi.fn(async () => httpErr(503))))
    const res = await replayL2Outbox(deps(vi.fn(async () => httpErr(503))))
    expect(res.replayed).toBe(0)
    expect(res.failed).toBe(1)
    expect(pendingCount(storage)).toBe(1)
  })
})
