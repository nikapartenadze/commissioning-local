/**
 * Tests: VFD validation writer convergence pass (batchWriteFlags).
 *
 * Background (2026-06-05 MCM02 freeze): the writer used to rewrite every
 * earned flag every 10 s with synchronous FFI â€” ~9.5 s of event-loop blocking
 * per cycle. The rewrite made the pass async and READ-COMPARE-WRITE: it only
 * writes flags whose PLC value diverged from L2 truth. These tests pin the
 * pass logic via the injectable PlcWriteOps seam (no DLL, no controller):
 *
 *   - already-correct flags are verified, NOT rewritten (current value comes
 *     from plc_tag_get_bit — clean 0/1; plc_tag_get_int8 carries ABI garbage
 *     in the upper register bytes and must never be truthiness-compared),
 *   - diverged flags are written (incl. polarity 0-values),
 *   - PLCTAG_ERR_NOT_FOUND is cached (knownMissingTags) and skipped on the
 *     next pass, and does NOT trip the circuit breaker,
 *   - N consecutive transient create failures abort the pass (CIP saturation
 *     guard, 2026-05-28 CDW5 incident),
 *   - ConnectionFaulted devices are skipped without any CIP traffic,
 *   - a PLC disconnect mid-pass stops the pass,
 *   - every non-negative handle is destroyed, even on failure paths.
 */
import { describe, it, expect } from 'vitest'
import {
  batchWriteFlags,
  clearKnownMissingTags,
  type PlcWriteOps,
  type ValidatedDevice,
} from '@/lib/vfd-validation-writer'
import { PlcTagStatus } from '@/lib/plc'

const OK = PlcTagStatus.PLCTAG_STATUS_OK
const NOT_FOUND = PlcTagStatus.PLCTAG_ERR_NOT_FOUND
const TIMEOUT = PlcTagStatus.PLCTAG_ERR_TIMEOUT

function device(name: string, writes: Array<{ field: string; value: number }>): ValidatedDevice {
  return { deviceName: name, writes, polarityRaw: null, hasDirection: false }
}

interface FakeCall { op: string; args: unknown[] }

/**
 * Build a fake PlcWriteOps whose per-tag behavior is driven by `plan`,
 * keyed by tag path. Defaults: create OK, read OK, current value matches
 * nothing (0), writes succeed. Records every call.
 */
function fakeOps(plan: Record<string, {
  createStatus?: number
  readStatus?: number
  current?: number
  writeStatus?: number
}> = {}): { ops: PlcWriteOps; calls: FakeCall[]; destroyed: number[]; created: string[] } {
  const calls: FakeCall[] = []
  const destroyed: number[] = []
  const created: string[] = []
  let nextHandle = 100
  const handleToTag = new Map<number, string>()

  const forTag = (name: string) => plan[name] ?? {}

  const ops: PlcWriteOps = {
    createTagAsync: async (config) => {
      calls.push({ op: 'create', args: [config.name] })
      created.push(config.name)
      const p = forTag(config.name)
      const status = p.createStatus ?? OK
      if (status === OK || status !== NOT_FOUND) {
        // Async create yields a live handle even for most failures.
        const handle = nextHandle++
        handleToTag.set(handle, config.name)
        return { handle, status }
      }
      // NOT_FOUND also has a live handle in the async pattern.
      const handle = nextHandle++
      handleToTag.set(handle, config.name)
      return { handle, status }
    },
    readTagAsync: async (handle) => {
      calls.push({ op: 'read', args: [handle] })
      return forTag(handleToTag.get(handle)!).readStatus ?? OK
    },
    writeTagAsync: async (handle) => {
      calls.push({ op: 'write', args: [handle] })
      return forTag(handleToTag.get(handle)!).writeStatus ?? OK
    },
    getBit: (handle) => forTag(handleToTag.get(handle)!).current ?? 0,
    setInt8: (handle, _offset, value) => {
      calls.push({ op: 'set', args: [handle, value] })
      return 0
    },
    destroy: (handle) => { destroyed.push(handle) },
  }
  return { ops, calls, destroyed, created }
}

// Unique gateway per test â€” knownMissingTags is module state keyed by
// `${gateway}::${tagPath}`, so distinct gateways keep tests independent.
let gwCounter = 0
function gw(): string { return `10.0.0.${++gwCounter}` }

const connected = () => true

describe('batchWriteFlags â€” read-compare-write', () => {
  it('already-correct flags are verified, not rewritten', async () => {
    const dev = device('UL1_1_VFD', [{ field: 'Valid_Map', value: 1 }, { field: 'Valid_HP', value: 1 }])
    // PLC reports the bit set: plc_tag_get_bit → 1. Desired is 1.
    const { ops, calls, destroyed } = fakeOps({
      'CBT_UL1_1_VFD.CTRL.CMD.Valid_Map': { current: 1 },
      'CBT_UL1_1_VFD.CTRL.CMD.Valid_HP': { current: 1 },
    })

    const res = await batchWriteFlags(gw(), '1,0', [dev], new Set(), connected, ops)

    expect(res).toMatchObject({ ok: 0, verified: 2, fail: 0, disconnected: false, abortedAt: null })
    expect(calls.filter(c => c.op === 'write')).toHaveLength(0)
    expect(calls.filter(c => c.op === 'set')).toHaveLength(0)
    expect(destroyed).toHaveLength(2) // every handle cleaned up
  })

  it('diverged flags are written â€” including polarity 0-values', async () => {
    // Post-download state: everything wiped to 0; polarity pair desired 1/0.
    const dev = device('UL2_2_VFD', [
      { field: 'Valid_Direction', value: 1 },
      { field: 'Normal_Polarity', value: 1 },
      { field: 'Reverse_Polarity', value: 0 },
    ])
    const { ops, calls } = fakeOps({
      'CBT_UL2_2_VFD.CTRL.CMD.Valid_Direction': { current: 0 },  // wiped â†’ write 1
      'CBT_UL2_2_VFD.CTRL.CMD.Normal_Polarity': { current: 0 },  // wiped â†’ write 1
      'CBT_UL2_2_VFD.CTRL.CMD.Reverse_Polarity': { current: 1 }, // stuck at 1, desired 0 â†’ write 0
    })

    // concurrency 1 â†’ deterministic set ordering for the assertion below
    const res = await batchWriteFlags(gw(), '1,0', [dev], new Set(), connected, ops, 1)

    expect(res).toMatchObject({ ok: 3, verified: 0, fail: 0 })
    const sets = calls.filter(c => c.op === 'set').map(c => c.args[1])
    expect(sets).toEqual([1, 1, 0])
  })

  it('concurrent pass (default pool) converges a post-download wipe correctly', async () => {
    // 20 devices Ã— 2 flags, half wiped half correct â€” counters must be exact
    // regardless of worker interleaving.
    const devices = Array.from({ length: 20 }, (_, i) =>
      device(`UL10_${i}_VFD`, [{ field: 'Valid_Map', value: 1 }, { field: 'Valid_HP', value: 1 }]))
    const plan: Record<string, { current?: number }> = {}
    for (let i = 0; i < 20; i++) {
      plan[`CBT_UL10_${i}_VFD.CTRL.CMD.Valid_Map`] = { current: i % 2 === 0 ? 0 : 1 }
      plan[`CBT_UL10_${i}_VFD.CTRL.CMD.Valid_HP`] = { current: i % 2 === 0 ? 0 : 1 }
    }
    const { ops, destroyed } = fakeOps(plan)

    const res = await batchWriteFlags(gw(), '1,0', devices, new Set(), connected, ops)

    expect(res).toMatchObject({ ok: 20, verified: 20, fail: 0, abortedAt: null, disconnected: false })
    expect(destroyed).toHaveLength(40) // every handle destroyed under concurrency
  })

  it('mixed pass: writes only the diverged subset', async () => {
    const dev = device('UL3_3_VFD', [{ field: 'Valid_Map', value: 1 }, { field: 'Valid_Direction', value: 1 }])
    const { ops } = fakeOps({
      'CBT_UL3_3_VFD.CTRL.CMD.Valid_Map': { current: 1 },     // correct
      'CBT_UL3_3_VFD.CTRL.CMD.Valid_Direction': { current: 0 }, // diverged
    })

    const res = await batchWriteFlags(gw(), '1,0', [dev], new Set(), connected, ops)
    expect(res).toMatchObject({ ok: 1, verified: 1, fail: 0 })
  })

  it('getBit error (negative status) → fail, no blind write, not verified', async () => {
    // Regression: battle env 2026-06-05 — current-value read must be trusted
    // only when it is a clean 0/1. A negative value is a libplctag error.
    const dev = device('UL11_1_VFD', [{ field: 'Valid_Map', value: 1 }])
    const { ops, calls } = fakeOps({
      'CBT_UL11_1_VFD.CTRL.CMD.Valid_Map': { current: -7 }, // PLCTAG_ERR_BAD_DATA-ish
    })

    const res = await batchWriteFlags(gw(), '1,0', [dev], new Set(), connected, ops)
    expect(res).toMatchObject({ ok: 0, verified: 0, fail: 1 })
    expect(calls.filter(c => c.op === 'write')).toHaveLength(0)
  })

  it('read failure â†’ counted as fail, no blind write', async () => {
    const dev = device('UL4_4_VFD', [{ field: 'Valid_Map', value: 1 }])
    const { ops, calls } = fakeOps({
      'CBT_UL4_4_VFD.CTRL.CMD.Valid_Map': { readStatus: TIMEOUT },
    })

    const res = await batchWriteFlags(gw(), '1,0', [dev], new Set(), connected, ops)
    expect(res).toMatchObject({ ok: 0, verified: 0, fail: 1 })
    expect(calls.filter(c => c.op === 'write')).toHaveLength(0)
  })
})

describe('batchWriteFlags â€” known-missing cache', () => {
  it('NOT_FOUND is cached: second pass skips the tag entirely', async () => {
    const gateway = gw()
    const dev = device('UL5_5_VFD', [{ field: 'Valid_Map', value: 1 }, { field: 'Valid_HP', value: 1 }])
    const plan = {
      'CBT_UL5_5_VFD.CTRL.CMD.Valid_Map': { createStatus: NOT_FOUND },
      'CBT_UL5_5_VFD.CTRL.CMD.Valid_HP': { current: 1 },
    }

    const first = fakeOps(plan)
    const res1 = await batchWriteFlags(gateway, '1,0', [dev], new Set(), connected, first.ops)
    expect(res1).toMatchObject({ fail: 1, verified: 1, skipped: 0, abortedAt: null })

    const second = fakeOps(plan)
    const res2 = await batchWriteFlags(gateway, '1,0', [dev], new Set(), connected, second.ops)
    expect(res2).toMatchObject({ fail: 0, verified: 1, skipped: 1 })
    // The missing tag was never re-created on pass 2.
    expect(second.created).toEqual(['CBT_UL5_5_VFD.CTRL.CMD.Valid_HP'])

    // clearKnownMissingTags (the reconnect path) re-probes it.
    clearKnownMissingTags('test reset')
    const third = fakeOps(plan)
    const res3 = await batchWriteFlags(gateway, '1,0', [dev], new Set(), connected, third.ops)
    expect(res3).toMatchObject({ fail: 1, skipped: 0 })
    expect(third.created).toContain('CBT_UL5_5_VFD.CTRL.CMD.Valid_Map')
  })

  it('NOT_FOUND does not trip the circuit breaker', async () => {
    // 6 devices, every tag NOT_FOUND (> MAX_CONSECUTIVE_CREATE_FAILURES=5):
    // definitive answers must not abort the pass.
    const devices = Array.from({ length: 6 }, (_, i) =>
      device(`UL6_${i}_VFD`, [{ field: 'Valid_Map', value: 1 }]))
    const plan = Object.fromEntries(devices.map(d =>
      [`CBT_${d.deviceName}.CTRL.CMD.Valid_Map`, { createStatus: NOT_FOUND }]))
    const { ops } = fakeOps(plan)

    const res = await batchWriteFlags(gw(), '1,0', devices, new Set(), connected, ops)
    expect(res.abortedAt).toBeNull()
    expect(res.fail).toBe(6)
  })
})

describe('batchWriteFlags â€” failure guards', () => {
  it('circuit breaker: 5 consecutive transient create failures abort the pass', async () => {
    const devices = Array.from({ length: 10 }, (_, i) =>
      device(`UL7_${i}_VFD`, [{ field: 'Valid_Map', value: 1 }]))
    const plan = Object.fromEntries(devices.map(d =>
      [`CBT_${d.deviceName}.CTRL.CMD.Valid_Map`, { createStatus: TIMEOUT }]))
    const { ops, created, destroyed } = fakeOps(plan)

    // concurrency 1 â†’ "consecutive" failures are strictly ordered
    const res = await batchWriteFlags(gw(), '1,0', devices, new Set(), connected, ops, 1)

    expect(res.abortedAt).toBe(4) // aborted at the 5th device (index 4)
    expect(created).toHaveLength(5) // stopped creating after the breaker tripped
    expect(destroyed).toHaveLength(5) // failed creates still destroyed their handles
  })

  it('faulted devices are skipped with zero CIP traffic', async () => {
    const devA = device('UL8_OK_VFD', [{ field: 'Valid_Map', value: 1 }])
    const devB = device('UL8_DOWN_VFD', [{ field: 'Valid_Map', value: 1 }, { field: 'Valid_HP', value: 1 }])
    const { ops, created } = fakeOps({ 'CBT_UL8_OK_VFD.CTRL.CMD.Valid_Map': { current: 1 } })

    const res = await batchWriteFlags(
      gw(), '1,0', [devA, devB], new Set(['UL8_DOWN_VFD']), connected, ops)

    expect(res).toMatchObject({ verified: 1, skippedFaulted: 1, fail: 0 })
    expect(created).toEqual(['CBT_UL8_OK_VFD.CTRL.CMD.Valid_Map'])
  })

  it('disconnect mid-pass stops before the next device', async () => {
    const devices = [
      device('UL9_1_VFD', [{ field: 'Valid_Map', value: 1 }]),
      device('UL9_2_VFD', [{ field: 'Valid_Map', value: 1 }]),
    ]
    const { ops, created } = fakeOps({
      'CBT_UL9_1_VFD.CTRL.CMD.Valid_Map': { current: 1 },
      'CBT_UL9_2_VFD.CTRL.CMD.Valid_Map': { current: 1 },
    })
    let callCount = 0
    const dropAfterFirst = () => ++callCount <= 1 // connected for device 1 only

    // concurrency 1 â†’ deterministic per-job isConnected sequencing
    const res = await batchWriteFlags(gw(), '1,0', devices, new Set(), dropAfterFirst, ops, 1)

    expect(res.disconnected).toBe(true)
    expect(res.verified).toBe(1)
    expect(created).toEqual(['CBT_UL9_1_VFD.CTRL.CMD.Valid_Map'])
  })
})
