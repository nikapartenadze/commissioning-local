/**
 * Tests: the "Clear Test" PLC reset sequence (app/api/vfd-commissioning/clear).
 *
 * INCIDENT: Clear Test manufactured permanently-stuck belts. It pulsed
 * Invalidate_Map → Invalidate_HP → Invalidate_Direction (+ Normal_Polarity=1,
 * Reverse_Polarity=0), and never sent Invalidate_Tracking_Finished at all.
 *
 * Per AOI_IOCT_BELT_TRACKING (rungs 0-10, verified against the L5X):
 *   - the WHOLE of rung 3 is gated on XIC(Valid_HP), and rung 3 is the only
 *     rung that can clear Tracking_Finished;
 *   - Invalidate_HP drops Valid_HP on rung 1.
 * So sending Invalidate_HP first killed the clearing rung, and since nothing
 * ever sent Invalidate_Tracking_Finished, the latch survived — and was then
 * UNCLEARABLE. On the MCM path all five went out as one batch, so they could
 * even collapse into a single scan.
 *
 * SECOND INCIDENT (same ladder, opposite end): ordering Invalidate_HP LAST
 * stopped the stranding but still left Valid_HP=0 — and rungs 2/3/4/5 are ALL
 * gated on XIC(Valid_HP), which is the master enable for every operator keypad
 * function. Clear Test handed mechanics a drive they could not start or
 * reverse. Invalidate_HP is no longer emitted at all; Invalidate_Map still is.
 *
 * These tests pin the corrected sequence through the pure/injectable seam —
 * no DB, no DLL, no controller.
 */
import { describe, it, expect } from 'vitest'
import {
  planClearPlcSequence,
  runClearPlcSequence,
  clearStsReads,
  resolveStsFromTypedReads,
  CLEAR_WRITE_ORDER,
  LATCH_WRITE_FIELDS,
  VALIDITY_WRITE_FIELDS,
  BELT_TRACKING_ON_MEMBERS,
  RVS_STOPPED_EPSILON,
  type RetractionSts,
} from '@/lib/vfd-clear-sequence'
import { RETRACTION_WRITE_ORDER } from '@/lib/vfd-validation-writer'

/** A provably-stopped, fully-valid drive: the only state that writes anything. */
function stopped(over: Partial<RetractionSts> = {}): RetractionSts {
  return { validHp: 1, beltTrackingOn: 0, rvs: 0, ...over }
}

/** Records the exact order of fields handed to the writer. */
function recorder(fail?: { field: string; error?: string }) {
  const issued: string[] = []
  const writeOne = async (field: string) => {
    issued.push(field)
    if (fail && field === fail.field) return { ok: false, error: fail.error ?? 'boom' }
    return { ok: true }
  }
  return { issued, writeOne }
}

describe('CLEAR_WRITE_ORDER', () => {
  it('is exactly the corrected order, ending at Invalidate_Map', () => {
    expect(CLEAR_WRITE_ORDER).toEqual([
      'Normal_Polarity',
      'Invalidate_Direction',
      'Invalidate_Tracking_Finished',
      'Invalidate_Map',
    ])
  })

  it('NEVER writes Invalidate_HP — it drops the master keypad enable (rungs 2/3/4/5)', () => {
    expect(CLEAR_WRITE_ORDER).not.toContain('Invalidate_HP')
    expect(VALIDITY_WRITE_FIELDS).not.toContain('Invalidate_HP')
    expect(LATCH_WRITE_FIELDS).not.toContain('Invalidate_HP')
  })

  it('still invalidates the Map, so the next OTL(Valid_HP) must be re-earned (rung 1)', () => {
    expect(VALIDITY_WRITE_FIELDS).toEqual(['Invalidate_Map'])
  })

  it('reuses the writer\'s retraction prefix verbatim, so the two cannot drift', () => {
    expect(CLEAR_WRITE_ORDER.slice(0, 3)).toEqual([...RETRACTION_WRITE_ORDER])
    expect(LATCH_WRITE_FIELDS).toEqual([...RETRACTION_WRITE_ORDER])
  })

  it('never writes the dead tag Stop_Belt_Tracking (0 of 11 rungs use it)', () => {
    expect(CLEAR_WRITE_ORDER).not.toContain('Stop_Belt_Tracking')
  })

  it('never writes CMD.Reverse_Polarity — rung 8 FLLs CMD to 0 each scan, so a 0 is a no-op', () => {
    expect(CLEAR_WRITE_ORDER).not.toContain('Reverse_Polarity')
  })
})

describe('planClearPlcSequence — stopped-drive guard', () => {
  it('proceeds only when tracking is off, RVS~0 and Valid_HP=1', () => {
    expect(planClearPlcSequence(stopped()).action).toBe('proceed')
  })

  it('ABORTS while belt tracking is still running', () => {
    const plan = planClearPlcSequence(stopped({ beltTrackingOn: 1 }))
    expect(plan.action).toBe('abort')
    expect(plan.reason).toMatch(/RUNNING/)
  })

  it('ABORTS when the drive is still commanded to move', () => {
    expect(planClearPlcSequence(stopped({ rvs: 12.5 })).action).toBe('abort')
    expect(planClearPlcSequence(stopped({ rvs: -12.5 })).action).toBe('abort')
    expect(planClearPlcSequence(stopped({ rvs: RVS_STOPPED_EPSILON })).action).toBe('abort')
  })

  it('treats sub-epsilon float noise as stopped', () => {
    expect(planClearPlcSequence(stopped({ rvs: 0.01 })).action).toBe('proceed')
    expect(planClearPlcSequence(stopped({ rvs: -0.01 })).action).toBe('proceed')
  })

  it('ABORTS when stopped-ness is UNPROVABLE — neither AOI rev\'s member readable', () => {
    const plan = planClearPlcSequence(stopped({ beltTrackingOn: null }))
    expect(plan.action).toBe('abort')
    expect(plan.reason).toMatch(/Belt_Tracking_ON.*Track_Belt/)
  })

  it('ABORTS when RVS is unreadable', () => {
    expect(planClearPlcSequence(stopped({ rvs: null })).action).toBe('abort')
  })

  it('ABORTS when Valid_HP is unreadable — we would be writing blind', () => {
    expect(planClearPlcSequence(stopped({ validHp: null })).action).toBe('abort')
  })

  it('proves stopped-ness BEFORE considering Valid_HP: a running drive with Valid_HP=0 still aborts', () => {
    // Order matters — the rung-1 writes are dangerous under motion too (rung 5
    // gates Start on Valid_HP but ALSO gates the Stop branch on it, so
    // Invalidate_HP on a moving belt de-asserts Start without asserting Stop).
    const plan = planClearPlcSequence({ validHp: 0, beltTrackingOn: 1, rvs: 30 })
    expect(plan.action).toBe('abort')
  })

  it('reports Valid_HP=0 as latch-unclearable rather than pretending to clear it', () => {
    const plan = planClearPlcSequence(stopped({ validHp: 0 }))
    expect(plan.action).toBe('proceed-without-latch-writes')
    expect(plan.reason).toMatch(/rung 3 is gated on Valid_HP/)
  })
})

describe('runClearPlcSequence — emitted order', () => {
  it('emits the four pulses in the corrected order', async () => {
    const { issued, writeOne } = recorder()
    const r = await runClearPlcSequence(stopped(), writeOne)
    expect(r.action).toBe('proceed')
    expect(issued).toEqual([
      'Normal_Polarity',
      'Invalidate_Direction',
      'Invalidate_Tracking_Finished',
      'Invalidate_Map',
    ])
    expect(r.latchCleared).toBe(true)
  })

  it('THE FIRST BUG: nothing that touches rung 1 precedes the latch invalidate', async () => {
    const { issued, writeOne } = recorder()
    await runClearPlcSequence(stopped(), writeOne)
    // Invalidate_Map, which seals Valid_HP's OTL on rung 1, comes after.
    expect(issued.indexOf('Invalidate_Map')).toBeGreaterThan(
      issued.indexOf('Invalidate_Tracking_Finished'),
    )
  })

  it('THE SECOND BUG: Clear Test leaves the keypad alive — Invalidate_HP is never issued', async () => {
    const { issued, writeOne } = recorder()
    const r = await runClearPlcSequence(stopped(), writeOne)
    expect(issued).not.toContain('Invalidate_HP')
    expect(r.writes.map(w => w.field)).not.toContain('Invalidate_HP')
  })

  it('Normal_Polarity lands FIRST, while the latch is still set (rung 3 branch 4)', async () => {
    const { issued, writeOne } = recorder()
    await runClearPlcSequence(stopped(), writeOne)
    expect(issued[0]).toBe('Normal_Polarity')
    expect(issued.indexOf('Normal_Polarity')).toBeLessThan(
      issued.indexOf('Invalidate_Tracking_Finished'),
    )
  })

  it('always sends Invalidate_Tracking_Finished — the write the old route omitted entirely', async () => {
    const { issued, writeOne } = recorder()
    await runClearPlcSequence(stopped(), writeOne)
    expect(issued).toContain('Invalidate_Tracking_Finished')
  })

  it('issues one field per call — never a batch that could collapse into one scan', async () => {
    const calls: string[][] = []
    await runClearPlcSequence(stopped(), async (field) => {
      calls.push([field])
      return { ok: true }
    })
    expect(calls).toHaveLength(4)
    expect(calls.every(c => c.length === 1)).toBe(true)
  })

  it('writes NOTHING at all when the guard aborts', async () => {
    for (const sts of [
      stopped({ beltTrackingOn: 1 }),
      stopped({ beltTrackingOn: null }),
      stopped({ rvs: 30 }),
      stopped({ rvs: null }),
      stopped({ validHp: null }),
    ]) {
      const { issued, writeOne } = recorder()
      const r = await runClearPlcSequence(sts, writeOne)
      expect(r.action).toBe('abort')
      expect(issued).toEqual([])
      expect(r.writes).toEqual([])
      expect(r.latchCleared).toBe(false)
    }
  })

  it('on Valid_HP=0 skips the dead rung-3 writes but still does the rung-1 write', async () => {
    const { issued, writeOne } = recorder()
    const r = await runClearPlcSequence(stopped({ validHp: 0 }), writeOne)
    expect(r.action).toBe('proceed-without-latch-writes')
    expect(issued).toEqual(['Invalidate_Map'])
    expect(r.latchCleared).toBe(false)
    // The dead writes are reported as skipped, not as successes.
    for (const f of LATCH_WRITE_FIELDS) {
      const row = r.writes.find(w => w.field === f)
      expect(row?.skipped).toBe(true)
      expect(row?.ok).toBe(false)
    }
  })
})

describe('runClearPlcSequence — failure handling', () => {
  it('a failed Invalidate_Tracking_Finished ABORTS the rest — the reset did not happen', async () => {
    const { issued, writeOne } = recorder({ field: 'Invalidate_Tracking_Finished' })
    const r = await runClearPlcSequence(stopped(), writeOne)
    expect(issued).toEqual([
      'Normal_Polarity', 'Invalidate_Direction', 'Invalidate_Tracking_Finished',
    ])
    expect(issued).not.toContain('Invalidate_HP')
    expect(issued).not.toContain('Invalidate_Map')
    expect(r.latchCleared).toBe(false)
    const map = r.writes.find(w => w.field === 'Invalidate_Map')
    expect(map?.skipped).toBe(true)
    expect(map?.error).toMatch(/did not complete/)
  })

  it('a failed Normal_Polarity aborts too — the latch must not drop with polarity unrestored', async () => {
    const { issued, writeOne } = recorder({ field: 'Normal_Polarity' })
    const r = await runClearPlcSequence(stopped(), writeOne)
    expect(issued).toEqual(['Normal_Polarity'])
    expect(r.latchCleared).toBe(false)
    expect(r.writes.map(w => w.field)).toEqual([...CLEAR_WRITE_ORDER])
  })

  it('a failed Invalidate_Map does not undo the latch clear — the safety-critical part succeeded', async () => {
    const { issued, writeOne } = recorder({ field: 'Invalidate_Map' })
    const r = await runClearPlcSequence(stopped(), writeOne)
    expect(issued).toEqual([...CLEAR_WRITE_ORDER])
    expect(r.latchCleared).toBe(true)
    expect(r.writes.find(w => w.field === 'Invalidate_Map')?.ok).toBe(false)
  })
})

describe('STS resolution — both AOI revisions', () => {
  it('requests Valid_HP, both belt-tracking member names, and RVS', () => {
    const reads = clearStsReads('CV0010')
    expect(reads.map(r => r.name)).toEqual([
      'CBT_CV0010.CTRL.STS.Valid_HP',
      'CBT_CV0010.CTRL.STS.Belt_Tracking_ON',
      'CBT_CV0010.CTRL.STS.Track_Belt',
      'CBT_CV0010.CTRL.STS.RVS',
    ])
    expect(reads[reads.length - 1].dataType).toBe('REAL')
    expect(BELT_TRACKING_ON_MEMBERS).toEqual(['Belt_Tracking_ON', 'Track_Belt'])
  })

  it('AOI222: reads Belt_Tracking_ON when present', () => {
    const sts = resolveStsFromTypedReads([
      { success: true, value: true },   // Valid_HP
      { success: true, value: false },  // Belt_Tracking_ON
      { success: false, error: 'tag not found' }, // Track_Belt (absent on this rev)
      { success: true, value: 0 },      // RVS
    ])
    expect(sts).toEqual({ validHp: 1, beltTrackingOn: 0, rvs: 0 })
    expect(planClearPlcSequence(sts).action).toBe('proceed')
  })

  it('older rev: falls back to Track_Belt when Belt_Tracking_ON is absent — no throw', () => {
    const sts = resolveStsFromTypedReads([
      { success: true, value: 1 },
      { success: false, error: 'tag not found' }, // Belt_Tracking_ON absent
      { success: true, value: false },            // Track_Belt
      { success: true, value: 0 },
    ])
    expect(sts).toEqual({ validHp: 1, beltTrackingOn: 0, rvs: 0 })
    expect(planClearPlcSequence(sts).action).toBe('proceed')
  })

  it('older rev, belt RUNNING via Track_Belt: aborts', () => {
    const sts = resolveStsFromTypedReads([
      { success: true, value: 1 },
      { success: false },
      { success: true, value: true }, // Track_Belt = running
      { success: true, value: 30 },
    ])
    expect(sts.beltTrackingOn).toBe(1)
    expect(planClearPlcSequence(sts).action).toBe('abort')
  })

  it('NEITHER member present → beltTrackingOn null → abort, not a throw', () => {
    const sts = resolveStsFromTypedReads([
      { success: true, value: 1 },
      { success: false },
      { success: false },
      { success: true, value: 0 },
    ])
    expect(sts.beltTrackingOn).toBeNull()
    expect(planClearPlcSequence(sts).action).toBe('abort')
  })

  it('a totally empty / undefined read batch degrades to all-null → abort', () => {
    expect(resolveStsFromTypedReads(undefined)).toEqual({ validHp: null, beltTrackingOn: null, rvs: null })
    expect(resolveStsFromTypedReads([]).beltTrackingOn).toBeNull()
    expect(planClearPlcSequence(resolveStsFromTypedReads([])).action).toBe('abort')
  })

  it('a non-numeric or non-finite RVS is unreadable, not 0', () => {
    const bad = (v: unknown) => resolveStsFromTypedReads([
      { success: true, value: 1 }, { success: true, value: false }, { success: false },
      { success: true, value: v },
    ]).rvs
    expect(bad('0')).toBeNull()
    expect(bad(NaN)).toBeNull()
    expect(bad(null)).toBeNull()
    expect(bad(0)).toBe(0)
  })
})

/**
 * Both route branches (MCM-routed and legacy singleton) funnel through
 * runClearPlcSequence with the same STS shape, differing only in transport.
 * These simulate each transport's failure modes at that seam.
 */
describe('both route branches', () => {
  it('MCM branch: typed-read batch → same order, HP last', async () => {
    const issued: string[] = []
    const stsBatch = {
      connected: true,
      results: [
        { success: true, value: true },  // Valid_HP
        { success: true, value: false }, // Belt_Tracking_ON
        { success: false },              // Track_Belt
        { success: true, value: 0 },     // RVS
      ],
    }
    const r = await runClearPlcSequence(
      resolveStsFromTypedReads(stsBatch.results),
      async (field) => { issued.push(field); return { ok: true } },
    )
    expect(r.action).toBe('proceed')
    expect(issued).toEqual([...CLEAR_WRITE_ORDER])
    expect(issued).not.toContain('Invalidate_HP')
  })

  it('MCM branch: disconnect mid-sequence aborts the remaining writes', async () => {
    const issued: string[] = []
    const r = await runClearPlcSequence(stopped(), async (field) => {
      issued.push(field)
      if (field === 'Invalidate_Direction') return { ok: false, error: 'MCM 15 disconnected mid-sequence' }
      return { ok: true }
    })
    expect(issued).toEqual(['Normal_Polarity', 'Invalidate_Direction'])
    expect(r.latchCleared).toBe(false)
  })

  it('singleton branch: FFI reads that return null (tag absent) abort the sequence', async () => {
    // readStsForFfi maps a null read to { success: false }; simulate that.
    const sts = resolveStsFromTypedReads([
      { success: true, value: 1 }, { success: false }, { success: false }, { success: false },
    ])
    const { issued, writeOne } = recorder()
    const r = await runClearPlcSequence(sts, writeOne)
    expect(r.action).toBe('abort')
    expect(issued).toEqual([])
  })

  it('singleton branch: running belt writes nothing', async () => {
    const sts = resolveStsFromTypedReads([
      { success: true, value: 1 },
      { success: true, value: true }, // Belt_Tracking_ON = running
      { success: false },
      { success: true, value: 30 },
    ])
    const { issued, writeOne } = recorder()
    const r = await runClearPlcSequence(sts, writeOne)
    expect(r.action).toBe('abort')
    expect(issued).toEqual([])
  })
})
