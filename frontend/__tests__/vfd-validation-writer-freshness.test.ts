/**
 * Tests: belt-tracking freshness gate + untrack retraction (MCM15, 2026-07-22).
 *
 * INCIDENT: four tool instances were simultaneously connected to MCM15 (two
 * sharing the hostname "autstand"). vfd-validation-writer is ASSERT-ONLY and
 * LEVEL-triggered on the local 'Belt Tracked' L2 cell, so ANY instance holding
 * a stale 'Yes' re-latched Tracking_Finished on the shared controller minutes
 * after someone cleared it elsewhere. Per AOI rung 3 that latch transfers
 * polarity ownership away from the keypad, so mechanics physically could not
 * change belt direction. Four hours lost finding the offending instance.
 *
 * And nothing ever un-latched the PLC: Invalidate_Tracking_Finished was written
 * by NO code path, so an untrack left the controller latched forever.
 *
 * These tests pin both fixes through the pure/injectable seams — no DB, no DLL,
 * no controller:
 *
 *   FRESHNESS  judgeBeltTrackingFreshness / stripBeltTrackingWrites
 *     - fresh when the cloud SSE stream is live,
 *     - fresh when a cloud delta for the subsystem landed THIS process,
 *     - STALE when never synced, when offline, and when the durable cursor
 *       predates process start (a rebooted offline box must not inherit
 *       pre-restart freshness),
 *     - only the belt-tracking flags are stripped; Valid_Map / Valid_HP survive.
 *
 *   RETRACTION  computeRetractionEdges / planRetraction / retractDeviceOnFfi
 *     - fires ONCE on the tracked→untracked EDGE,
 *     - never fires for devices that were simply never tracked,
 *     - emits nothing at all on the first-ever run (baseline seeding),
 *     - DEFERS while the drive is running, and while "stopped" is unprovable,
 *     - SKIPS when STS.Valid_HP=0 (AOI rung 3 is gated on it — the write
 *       would silently do nothing),
 *     - writes exactly Normal_Polarity → Invalidate_Direction →
 *       Invalidate_Tracking_Finished, in that order, and NEVER Invalidate_HP.
 */
import { describe, it, expect } from 'vitest'
import {
  judgeBeltTrackingFreshness,
  stripBeltTrackingWrites,
  computeRetractionEdges,
  planRetraction,
  retractDeviceOnFfi,
  readRetractionSts,
  RETRACTION_WRITE_ORDER,
  BELT_TRACKING_ON_MEMBERS,
  type FreshnessProbe,
  type PlcRetractOps,
} from '@/lib/vfd-validation-writer'
import { PlcTagStatus } from '@/lib/plc'

const OK = PlcTagStatus.PLCTAG_STATUS_OK
const BAD_PARAM = PlcTagStatus.PLCTAG_ERR_BAD_PARAM

const NOW = 1_800_000_000_000
const PROC_START = NOW - 60 * 60_000 // process booted an hour ago
const THRESHOLD = 15 * 60_000

function probe(over: Partial<FreshnessProbe> = {}): FreshnessProbe {
  return { sseConnected: false, sseLastEventMs: null, cursorUpdatedMs: null, ...over }
}

// ── Freshness gate ─────────────────────────────────────────────────

describe('judgeBeltTrackingFreshness', () => {
  it('FRESH when the cloud SSE stream is connected and recently framed', () => {
    const v = judgeBeltTrackingFreshness(
      probe({ sseConnected: true, sseLastEventMs: NOW - 30_000 }), NOW, PROC_START, THRESHOLD,
    )
    expect(v.fresh).toBe(true)
    expect(v.reason).toMatch(/SSE live/i)
  })

  it('FRESH when a cloud delta for this subsystem landed inside the window, this process', () => {
    const v = judgeBeltTrackingFreshness(
      probe({ cursorUpdatedMs: NOW - 5 * 60_000 }), NOW, PROC_START, THRESHOLD,
    )
    expect(v.fresh).toBe(true)
    expect(v.reason).toMatch(/delta applied/i)
  })

  it('STALE when nothing has ever confirmed — the never-synced instance goes quiet', () => {
    const v = judgeBeltTrackingFreshness(probe(), NOW, PROC_START, THRESHOLD)
    expect(v.fresh).toBe(false)
    expect(v.reason).toMatch(/not connected/i)
    expect(v.reason).toMatch(/no delta cursor/i)
  })

  it('STALE when the SSE stream dropped, even if it framed recently', () => {
    // This is the MCM15 instance: it still holds a local 'Yes' but is no longer
    // on the channel the untrack would arrive on.
    const v = judgeBeltTrackingFreshness(
      probe({ sseConnected: false, sseLastEventMs: NOW - 10_000 }), NOW, PROC_START, THRESHOLD,
    )
    expect(v.fresh).toBe(false)
  })

  it('STALE when the SSE stream is connected but has gone quiet past the threshold', () => {
    const v = judgeBeltTrackingFreshness(
      probe({ sseConnected: true, sseLastEventMs: NOW - THRESHOLD - 1 }), NOW, PROC_START, THRESHOLD,
    )
    expect(v.fresh).toBe(false)
  })

  it('STALE when the delta cursor is recent but PREDATES process start', () => {
    // A box that synced, was powered off, and rebooted with no network. The
    // durable stamp is young in wall-clock terms but this process has never
    // reached the cloud, so it must not assert.
    const v = judgeBeltTrackingFreshness(
      probe({ cursorUpdatedMs: PROC_START - 60_000 }), NOW, PROC_START - 30_000, THRESHOLD,
    )
    expect(v.fresh).toBe(false)
    expect(v.reason).toMatch(/predates this process start/i)
  })

  it('STALE when the delta cursor is from this process but older than the threshold', () => {
    const v = judgeBeltTrackingFreshness(
      probe({ cursorUpdatedMs: NOW - THRESHOLD - 1 }), NOW, PROC_START, THRESHOLD,
    )
    expect(v.fresh).toBe(false)
  })

  it('ignores a cursor timestamp from the future (clock skew) rather than trusting it', () => {
    const v = judgeBeltTrackingFreshness(
      probe({ cursorUpdatedMs: NOW + 10 * 60_000 }), NOW, PROC_START, THRESHOLD,
    )
    expect(v.fresh).toBe(false)
  })
})

describe('stripBeltTrackingWrites', () => {
  const full = [
    { field: 'Valid_Map', value: 1 },
    { field: 'Valid_HP', value: 1 },
    { field: 'Tracking_Finished', value: 1 },
    { field: 'Valid_Direction', value: 1 },
    { field: 'Normal_Polarity', value: 0 },
    { field: 'Reverse_Polarity', value: 1 },
  ]

  it('drops exactly the belt-tracking flags and keeps the wizard flags', () => {
    // Valid_Map/Valid_HP come from LOCAL wizard truth, not a cloud tracking
    // decision — gating them would strand mech without the keypad unlock.
    expect(stripBeltTrackingWrites(full)).toEqual([
      { field: 'Valid_Map', value: 1 },
      { field: 'Valid_HP', value: 1 },
    ])
  })

  it('returns the SAME array reference when nothing is gated (no allocation on the hot path)', () => {
    const wizardOnly = [{ field: 'Valid_Map', value: 1 }]
    expect(stripBeltTrackingWrites(wizardOnly)).toBe(wizardOnly)
  })

  it('a stale instance asserting nothing is silent, not destructive (no 0-writes emitted)', () => {
    // Silence is the safe failure: the AOI latch is retentive, so declining to
    // assert never un-does correct state.
    expect(stripBeltTrackingWrites(full).every(w => w.value === 1)).toBe(true)
    expect(stripBeltTrackingWrites(full).some(w => /Invalidate/.test(w.field))).toBe(false)
  })
})

// ── Retraction: edge detection ─────────────────────────────────────

describe('computeRetractionEdges', () => {
  it('FIRST EVER run seeds the baseline and emits NO edges', () => {
    // The critical anti-footgun: level-triggering would pulse invalidate at
    // every device that was simply never tracked, on every reconnect.
    const r = computeRetractionEdges(null, new Set(['A', 'B']), new Set())
    expect(r.newlyUntracked).toEqual([])
    expect(Array.from(r.nextTracked).sort()).toEqual(['A', 'B'])
    expect(r.nextPending.size).toBe(0)
  })

  it('fires on the tracked→untracked EDGE', () => {
    const r = computeRetractionEdges(new Set(['A', 'B']), new Set(['A']), new Set())
    expect(r.newlyUntracked).toEqual(['B'])
    expect(Array.from(r.nextPending)).toEqual(['B'])
  })

  it('does NOT fire for devices that were never tracked', () => {
    // C and D are not in prevTracked and not tracked now — most of the fleet.
    const r = computeRetractionEdges(new Set(['A']), new Set(['A']), new Set())
    expect(r.newlyUntracked).toEqual([])
    expect(r.nextPending.size).toBe(0)
  })

  it('fires ONCE — a second pass over the same state produces no new edge', () => {
    const first = computeRetractionEdges(new Set(['A', 'B']), new Set(['A']), new Set())
    expect(first.newlyUntracked).toEqual(['B'])
    // Simulate the retraction having succeeded (pending cleared) and re-run.
    const second = computeRetractionEdges(first.nextTracked, new Set(['A']), new Set())
    expect(second.newlyUntracked).toEqual([])
    expect(second.nextPending.size).toBe(0)
  })

  it('keeps the debt pending across passes until it is cleared (survives restart)', () => {
    const first = computeRetractionEdges(new Set(['B']), new Set(), new Set())
    expect(Array.from(first.nextPending)).toEqual(['B'])
    // Next pass, retraction still deferred (drive running) → still owed.
    const second = computeRetractionEdges(first.nextTracked, new Set(), first.nextPending)
    expect(Array.from(second.nextPending)).toEqual(['B'])
  })

  it('cancels a pending retraction when mech re-tracks the device', () => {
    const r = computeRetractionEdges(new Set(), new Set(['B']), new Set(['B']))
    expect(r.nextPending.size).toBe(0)
  })

  it('accumulates multiple simultaneous untracks', () => {
    const r = computeRetractionEdges(new Set(['A', 'B', 'C']), new Set(['A']), new Set())
    expect(r.newlyUntracked).toEqual(['B', 'C'])
  })
})

// ── Retraction: safety plan ────────────────────────────────────────

describe('planRetraction', () => {
  it('retracts when Valid_HP=1, belt tracking off and RVS ~ 0', () => {
    const p = planRetraction({ validHp: 1, beltTrackingOn: 0, rvs: 0 })
    expect(p.action).toBe('retract')
  })

  it('SKIPS when STS.Valid_HP=0 — AOI rung 3 is gated on Valid_HP', () => {
    // The whole rung (including OTU(Tracking_Finished)) sits under XIC(Valid_HP),
    // so the invalidate would SILENTLY do nothing.
    const p = planRetraction({ validHp: 0, beltTrackingOn: 0, rvs: 0 })
    expect(p.action).toBe('skip')
    expect(p.reason).toMatch(/Valid_HP/)
  })

  it('DEFERS while the belt is still tracking — never reverse a moving belt', () => {
    // Unlatching Tracking_Finished hands Reverse_Polarity back to the keypad
    // (rung 3) and rung 7's DirectionCmd mapping is UNCONDITIONAL, so this
    // would issue a direction reversal with Start still asserted.
    const p = planRetraction({ validHp: 1, beltTrackingOn: 1, rvs: 0 })
    expect(p.action).toBe('defer')
    expect(p.reason).toMatch(/RUNNING/i)
  })

  it('DEFERS while commanded velocity is non-zero even with tracking mode off', () => {
    const p = planRetraction({ validHp: 1, beltTrackingOn: 0, rvs: 30 })
    expect(p.action).toBe('defer')
    expect(p.reason).toMatch(/RVS/)
  })

  it('DEFERS when stopped-ness cannot be PROVEN (missing STS members, unreadable RVS)', () => {
    expect(planRetraction({ validHp: 1, beltTrackingOn: null, rvs: 0 }).action).toBe('defer')
    expect(planRetraction({ validHp: 1, beltTrackingOn: 0, rvs: null }).action).toBe('defer')
    expect(planRetraction({ validHp: null, beltTrackingOn: 0, rvs: 0 }).action).toBe('defer')
  })

  it('tolerates float noise around zero', () => {
    expect(planRetraction({ validHp: 1, beltTrackingOn: 0, rvs: -0.01 }).action).toBe('retract')
  })
})

// ── Retraction: write ordering against a fake controller ───────────

interface FakeCall { op: string; tag: string; value?: number }

/**
 * Fake PlcRetractOps. `sts` supplies STS values by member name; a member
 * absent from `sts` answers BAD_PARAM at createTag (the real signature for an
 * AOI member that isn't in the downloaded program) so the "missing member must
 * not throw" contract is exercised.
 */
function fakeOps(
  sts: Record<string, number>,
  opts: { failWrite?: string } = {},
): { ops: PlcRetractOps; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  let nextHandle = 1
  const handles = new Map<number, { tag: string; value: number }>()

  const ops: PlcRetractOps = {
    createTagAsync: async (config) => {
      const tag = config.name
      const member = tag.split('.').pop() as string
      calls.push({ op: 'create', tag })
      if (tag.includes('.CTRL.STS.') && !(member in sts)) {
        return { handle: -1, status: BAD_PARAM }
      }
      const handle = nextHandle++
      handles.set(handle, { tag, value: sts[member] ?? 0 })
      return { handle, status: OK }
    },
    readTagAsync: async (handle) => {
      calls.push({ op: 'read', tag: handles.get(handle)?.tag ?? '?' })
      return OK
    },
    writeTagAsync: async (handle) => {
      const h = handles.get(handle)!
      calls.push({ op: 'write', tag: h.tag, value: h.value })
      return h.tag.endsWith(opts.failWrite ?? ' ') ? PlcTagStatus.PLCTAG_ERR_TIMEOUT : OK
    },
    getBit: (handle) => (handles.get(handle)!.value !== 0 ? 1 : 0),
    getFloat32: (handle) => handles.get(handle)!.value,
    setInt8: (handle, _offset, value) => {
      handles.get(handle)!.value = value
      return OK
    },
    destroy: (handle) => {
      calls.push({ op: 'destroy', tag: handles.get(handle)?.tag ?? '?' })
      handles.delete(handle)
    },
  }
  return { ops, calls }
}

const STOPPED_AOI222 = { Valid_HP: 1, Belt_Tracking_ON: 0, RVS: 0 }

describe('retractDeviceOnFfi', () => {
  it('writes exactly Normal_Polarity → Invalidate_Direction → Invalidate_Tracking_Finished, in order', () => {
    // Order is load-bearing: CMD.Normal_Polarity is only honoured on rung 3's
    // XIC(Tracking_Finished) branch — i.e. WHILE THE LATCH IS STILL SET — and
    // Valid_Direction needs its own pulse (rung 6). The latch drops LAST.
    return retractDeviceOnFfi(fakeOps(STOPPED_AOI222).ops, '10.0.0.1', '1,0', 'UL9_9_VFD1')
      .then(outcome => {
        expect(outcome.action).toBe('retract')
        expect(outcome.written).toEqual([...RETRACTION_WRITE_ORDER])
      })
  })

  it('issues the three CMD writes in ladder order and NEVER Invalidate_HP', () => {
    const { ops, calls } = fakeOps(STOPPED_AOI222)
    return retractDeviceOnFfi(ops, '10.0.0.1', '1,0', 'UL9_9_VFD1').then(() => {
      const written = calls.filter(c => c.op === 'write').map(c => c.tag)
      expect(written).toEqual([
        'CBT_UL9_9_VFD1.CTRL.CMD.Normal_Polarity',
        'CBT_UL9_9_VFD1.CTRL.CMD.Invalidate_Direction',
        'CBT_UL9_9_VFD1.CTRL.CMD.Invalidate_Tracking_Finished',
      ])
      // Invalidate_HP would drop Valid_HP and make the tracking latch
      // PERMANENTLY unclearable (rung 3 is gated on Valid_HP).
      expect(calls.some(c => c.tag.includes('Invalidate_HP'))).toBe(false)
      // Stop_Belt_Tracking is a DEAD TAG — declared in the UDT, zero rungs.
      expect(calls.some(c => c.tag.includes('Stop_Belt_Tracking'))).toBe(false)
    })
  })

  it('all three writes carry value 1 (they are pulses, not clears)', () => {
    const { ops, calls } = fakeOps(STOPPED_AOI222)
    return retractDeviceOnFfi(ops, '10.0.0.1', '1,0', 'D1').then(() => {
      expect(calls.filter(c => c.op === 'write').every(c => c.value === 1)).toBe(true)
    })
  })

  it('writes NOTHING while the drive is running', async () => {
    const { ops, calls } = fakeOps({ Valid_HP: 1, Belt_Tracking_ON: 1, RVS: 30 })
    const outcome = await retractDeviceOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    expect(outcome.action).toBe('defer')
    expect(outcome.written).toEqual([])
    expect(calls.filter(c => c.op === 'write' && c.tag.includes('.CMD.'))).toEqual([])
  })

  it('writes NOTHING when Valid_HP=0', async () => {
    const { ops, calls } = fakeOps({ Valid_HP: 0, Belt_Tracking_ON: 0, RVS: 0 })
    const outcome = await retractDeviceOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    expect(outcome.action).toBe('skip')
    expect(calls.filter(c => c.op === 'write' && c.tag.includes('.CMD.'))).toEqual([])
  })

  it('ABORTS the sequence if a write fails — never drops the latch with polarity unrestored', async () => {
    const { ops } = fakeOps(STOPPED_AOI222, { failWrite: 'Invalidate_Direction' })
    const outcome = await retractDeviceOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    expect(outcome.action).toBe('failed')
    expect(outcome.written).toEqual(['Normal_Polarity'])
  })

  it('destroys every handle it opens, including failed STS probes', async () => {
    const { ops, calls } = fakeOps(STOPPED_AOI222)
    await retractDeviceOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    const created = calls.filter(c => c.op === 'create' && !c.tag.includes('Track_Belt')).length
    const destroyed = calls.filter(c => c.op === 'destroy').length
    // Track_Belt is never probed on an AOI222 device (Belt_Tracking_ON answers
    // first), and a BAD_PARAM create yields handle -1 which is not destroyed.
    expect(destroyed).toBe(created)
  })
})

describe('readRetractionSts — two AOI revisions', () => {
  it('reads Belt_Tracking_ON on AOI222', async () => {
    const { ops } = fakeOps({ Valid_HP: 1, Belt_Tracking_ON: 1, RVS: 0 })
    expect(await readRetractionSts(ops, 'g', 'p', 'D1')).toEqual({ validHp: 1, beltTrackingOn: 1, rvs: 0 })
  })

  it('falls back to Track_Belt on the older AOI rev — a missing member must not throw', async () => {
    const { ops, calls } = fakeOps({ Valid_HP: 1, Track_Belt: 1, RVS: 0 })
    const sts = await readRetractionSts(ops, 'g', 'p', 'D1')
    expect(sts).toEqual({ validHp: 1, beltTrackingOn: 1, rvs: 0 })
    // It probed the newest name first, got BAD_PARAM, then tried the old one.
    expect(calls.some(c => c.tag.endsWith('.STS.Belt_Tracking_ON'))).toBe(true)
    expect(calls.some(c => c.tag.endsWith('.STS.Track_Belt'))).toBe(true)
  })

  it('reports null (→ defer, never retract) when NEITHER member exists', async () => {
    const { ops } = fakeOps({ Valid_HP: 1, RVS: 0 })
    const sts = await readRetractionSts(ops, 'g', 'p', 'D1')
    expect(sts.beltTrackingOn).toBeNull()
    expect(planRetraction(sts).action).toBe('defer')
  })

  it('probes both known STS member names', () => {
    expect([...BELT_TRACKING_ON_MEMBERS]).toEqual(['Belt_Tracking_ON', 'Track_Belt'])
  })
})
