/**
 * F4 eviction hardening (FV-HARDENING-PLAN.md): the bounded-replay eviction may
 * only fire for PERMANENT rejections. Transient failures (offline, 5xx, the
 * version-lock 503) must never burn eviction strikes — evicting an edit that
 * would succeed after reconnect/update IS the data loss this plan exists to
 * stop. Evictions are returned to the caller (for the persistent toast) and
 * reported to the server-side recovery log.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { saveL2Cell, replayL2Outbox, pendingCount, type OutboxDeps } from '@/lib/l2-outbox'

function makeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
  }
}
const ok = () => ({ ok: true, status: 200, json: async () => ({ success: true }) })
const httpErr = (status: number) => ({ ok: false, status, json: async () => ({ error: `HTTP ${status}` }) })

let storage: ReturnType<typeof makeStorage>
const deps = (fetchFn: any): OutboxDeps => ({ storage, fetchFn, sleep: async () => {} })
const edit = { deviceId: 7, columnId: 8, value: 'SM 7/11', updatedBy: 'santiago', ts: 1 }

beforeEach(() => { storage = makeStorage() })

async function queueOne() {
  await saveL2Cell(edit, deps(vi.fn(async () => httpErr(503))))
  expect(pendingCount(storage)).toBe(1)
}

describe('replay eviction only on permanent rejections', () => {
  it('503 (server down / version-locked) replays NEVER evict — edit survives 20 passes', async () => {
    await queueOne()
    for (let i = 0; i < 20; i++) {
      const r = await replayL2Outbox(deps(vi.fn(async () => httpErr(503))))
      expect(r.evicted).toBe(0)
    }
    expect(pendingCount(storage)).toBe(1)
  })

  it('network-down replays NEVER evict', async () => {
    await queueOne()
    for (let i = 0; i < 20; i++) {
      await replayL2Outbox(deps(vi.fn(async () => { throw new Error('offline') })))
    }
    expect(pendingCount(storage)).toBe(1)
  })

  it('…and the surviving edit still lands once the server recovers', async () => {
    await queueOne()
    await replayL2Outbox(deps(vi.fn(async () => httpErr(503))))
    const r = await replayL2Outbox(deps(vi.fn(async () => ok())))
    expect(r.replayed).toBe(1)
    expect(pendingCount(storage)).toBe(0)
  })

  it('permanent 404 (stale local id after a pull) evicts after the strike cap, returns the edit, and reports it server-side', async () => {
    await queueOne()
    const calls: Array<{ url: string; body: any }> = []
    let evictedEdits: any[] = []
    for (let i = 0; i < 10 && pendingCount(storage) > 0; i++) {
      const fetchFn = vi.fn(async (url: string, init?: any) => {
        if (url === '/api/l2/outbox-evicted') {
          calls.push({ url, body: JSON.parse(init.body) })
          return ok()
        }
        return httpErr(404)
      })
      const r = await replayL2Outbox(deps(fetchFn))
      if (r.evictedEdits.length > 0) evictedEdits = r.evictedEdits
    }
    expect(pendingCount(storage)).toBe(0) // no infinite loop
    expect(evictedEdits).toHaveLength(1)
    expect(evictedEdits[0]).toMatchObject({ deviceId: 7, columnId: 8, value: 'SM 7/11' })
    // The eviction was reported into the durable server-side recovery log.
    expect(calls).toHaveLength(1)
    expect(calls[0].body.edits[0]).toMatchObject({ deviceId: 7, columnId: 8, value: 'SM 7/11' })
  })

  it('the eviction report failing (server unreachable) does not resurrect or crash the replay', async () => {
    await queueOne()
    for (let i = 0; i < 10 && pendingCount(storage) > 0; i++) {
      const fetchFn = vi.fn(async (url: string) => {
        if (url === '/api/l2/outbox-evicted') throw new Error('offline')
        return httpErr(404)
      })
      await replayL2Outbox(deps(fetchFn))
    }
    expect(pendingCount(storage)).toBe(0)
  })
})
