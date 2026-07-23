/**
 * Pure reconcile helpers behind the Compare-with-cloud panel's optimistic,
 * non-blocking action path (components/sync-compare.tsx). The component itself
 * isn't rendered here (no jsdom) — these functions ARE the logic: they edit the
 * already-loaded diff model in place so acting on a row is instant and never
 * triggers a full re-diff. Buckets/ordering mirror lib/sync/sync-diff.ts.
 */
import { describe, it, expect } from 'vitest'
import { removeRows, reinsertRows, rowKey } from '@/components/sync-compare'

type Cls = 'local_only' | 'local_newer' | 'cloud_newer' | 'cloud_only' | 'gone_on_cloud' | 'conflict'
type Act = 'push' | 'accept_cloud' | 'tombstone' | 'pull' | 'none'
const ACT: Record<Cls, Act> = {
  local_only: 'push', local_newer: 'push', cloud_newer: 'accept_cloud',
  cloud_only: 'pull', gone_on_cloud: 'tombstone', conflict: 'none',
}

function mk(id: number, classification: Cls) {
  return {
    id, name: `IO-${id}`, classification, reason: '', action: ACT[classification],
    localResult: 'Pass', localVersion: 1, localTimestamp: null,
    cloudResult: 'Fail', cloudVersion: 1,
  }
}

// Two MCMs. sub 101 rows pre-sorted in the diff route's rank order
// (conflict, local_newer, local_only, cloud_newer, gone_on_cloud); sub 202 too.
function makeData() {
  return {
    success: true,
    summary: { total: 20, inSync: 13, push: 3, acceptCloud: 1, tombstone: 1, pull: 1, conflict: 1 },
    perSubsystem: [
      {
        subsystemId: 101, mcm: 'MCM01', ok: true,
        summary: { total: 15, inSync: 10, push: 2, acceptCloud: 1, tombstone: 1, pull: 0, conflict: 1 },
        rows: [mk(5, 'conflict'), mk(1, 'local_newer'), mk(2, 'local_only'), mk(3, 'cloud_newer'), mk(4, 'gone_on_cloud')],
      },
      {
        subsystemId: 202, mcm: 'MCM02', ok: true,
        summary: { total: 5, inSync: 3, push: 1, acceptCloud: 0, tombstone: 0, pull: 1, conflict: 0 },
        rows: [mk(6, 'local_newer'), mk(7, 'cloud_only')],
      },
    ],
  }
}

const ids = (rows: ReadonlyArray<{ id: number }>) => rows.map((r) => r.id)

describe('rowKey', () => {
  it('is unique per subsystem+id so ids repeated across groups do not collide', () => {
    expect(rowKey(101, 5)).toBe('101:5')
    expect(rowKey(202, 5)).toBe('202:5')
    expect(rowKey(101, 5)).not.toBe(rowKey(202, 5))
  })
})

describe('removeRows', () => {
  it('drops the row from the target group and recounts that group + the top summary', () => {
    const data = makeData()
    const out = removeRows(data, 101, [1]) // a "push" (local_newer) row

    expect(ids(out.perSubsystem[0].rows!)).toEqual([5, 2, 3, 4])
    // group 101: push 2 -> 1, total fixed, inSync +1
    expect(out.perSubsystem[0].summary).toEqual({ total: 15, inSync: 11, push: 1, acceptCloud: 1, tombstone: 1, pull: 0, conflict: 1 })
    // top summary = sum of per-sub summaries: push 3 -> 2, inSync 13 -> 14
    expect(out.summary).toEqual({ total: 20, inSync: 14, push: 2, acceptCloud: 1, tombstone: 1, pull: 1, conflict: 1 })
  })

  it('does not mutate the input and leaves untouched groups by reference (React bail-out)', () => {
    const data = makeData()
    const out = removeRows(data, 101, [3])
    expect(out).not.toBe(data)
    expect(out.perSubsystem[0]).not.toBe(data.perSubsystem[0]) // edited group = new object
    expect(out.perSubsystem[1]).toBe(data.perSubsystem[1])     // other group untouched
    expect(data.perSubsystem[0].rows).toHaveLength(5)          // original intact
  })

  it('returns the SAME reference when nothing matched (no id / no such subsystem)', () => {
    const data = makeData()
    expect(removeRows(data, 101, [999])).toBe(data)
    expect(removeRows(data, 999, [1])).toBe(data)
    expect(removeRows(data, 101, [])).toBe(data)
  })

  it('keeps the (now empty) group object so a rollback can still find it', () => {
    const data = makeData()
    const out = removeRows(data, 202, [6, 7])
    expect(out.perSubsystem).toHaveLength(2)
    expect(out.perSubsystem[1].rows).toEqual([])
    expect(out.perSubsystem[1].ok).toBe(true)
    expect(out.perSubsystem[1].summary).toEqual({ total: 5, inSync: 5, push: 0, acceptCloud: 0, tombstone: 0, pull: 0, conflict: 0 })
    expect(out.summary.push).toBe(2) // 3 - group202's 1
    expect(out.summary.pull).toBe(0) // 1 - group202's 1
  })
})

describe('reinsertRows (rollback)', () => {
  it('round-trips: removeRows then reinsertRows restores rows, order, and every count', () => {
    const data = makeData()
    const snapshot = data.perSubsystem[0].rows.filter((r) => r.id === 1)
    const removed = removeRows(data, 101, [1])
    const restored = reinsertRows(removed, 101, snapshot)

    expect(ids(restored.perSubsystem[0].rows!)).toEqual([5, 1, 2, 3, 4]) // rank order back
    expect(restored.perSubsystem[0].summary).toEqual(data.perSubsystem[0].summary)
    expect(restored.summary).toEqual(data.summary)
  })

  it('skips ids already present so a double-apply cannot duplicate (same reference)', () => {
    const data = makeData()
    const dup = [mk(2, 'local_only')]
    expect(reinsertRows(data, 101, dup)).toBe(data)
    expect(reinsertRows(data, 101, [])).toBe(data)
  })

  it('composes with concurrent removals: rolling back one row does NOT resurrect another', () => {
    const data = makeData()
    const snap1 = data.perSubsystem[0].rows.filter((r) => r.id === 1)
    // Two independent in-flight actions removed rows 1 and 2 optimistically.
    const m1 = removeRows(data, 101, [1])
    const m2 = removeRows(m1, 101, [2])
    // Action for row 1 fails and rolls back — row 2 must stay gone.
    const m3 = reinsertRows(m2, 101, snap1)

    expect(ids(m3.perSubsystem[0].rows!)).toEqual([5, 1, 3, 4]) // 1 back, 2 still removed
    expect(m3.perSubsystem[0].summary!.push).toBe(1) // only local_newer(1); local_only(2) gone
    expect(m3.summary.push).toBe(2) // group101 1 + group202 1
  })
})
