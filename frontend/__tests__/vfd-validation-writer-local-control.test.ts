/**
 * Tests: LEVEL-based local-control restore for untracked belts.
 *
 * THE REQUIREMENT (user, verbatim): "if belt is not tracked we write back into
 * plc the necessary bits so the local controls are allowed".
 *
 * Mechanics drive the belt from the VFD keypad — F1 start/stop, F0+F2 held 5 s
 * to reverse, F0/F2 for speed trim. In AOI_IOCT_BELT_TRACKING_AOI222.L5X the
 * rungs implementing all of those (2 keypad direction, 4 keypad speed, 5 F1
 * start/stop) are gated `XIC(Valid_HP)`, as is the whole of rung 3. So
 * STS.Valid_HP=1 is the MASTER ENABLE for every local control: a belt with
 * Valid_HP=0 has a dead keypad and the mechanic can neither start it nor
 * change its direction.
 *
 * 948c70e made retraction EDGE-triggered on tracked→untracked. That never
 * recovers a Tracking_Finished latch that reappears from another source — the
 * wizard re-asserting, one of the four instances sharing MCM15, a state
 * predating the durable baseline, a manual Studio change. Four instances share
 * that controller, so this is routine, not hypothetical. Hence: also reconcile
 * on STATE, every sweep.
 *
 * Pinned here through the pure / injectable seams — no DB, no DLL, no PLC:
 *
 *   planLocalControlRestore
 *     - untracked + Valid_HP=0        → Valid_Map then Valid_HP then invalidate
 *     - untracked + already enabled   → the invalidate ONLY
 *     - running belt                  → defers EVERYTHING
 *     - unprovable stopped-ness       → defers (never proceeds)
 *     - Check_Allowed=0               → skips, does not fight the controller
 *
 *   restoreLocalControlOnFfi / …OnRemote
 *     - exact write order, all pulses of value 1, never Invalidate_HP /
 *       Invalidate_Map / Stop_Belt_Tracking
 *     - both AOI revisions (Belt_Tracking_ON vs Track_Belt), missing member
 *       must not throw
 *
 *   runLocalControlRestorePass
 *     - a stale instance does NOTHING (fails closed on a missing verdict)
 *     - a tracked belt is never touched
 *     - rate limit: converged devices are not even re-probed until due
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  planLocalControlRestore,
  restoreLocalControlOnFfi,
  restoreLocalControlOnRemote,
  readLocalControlSts,
  runLocalControlRestorePass,
  resetLocalControlBackoff,
  isLocalControlDue,
  LOCAL_CONTROL_WRITE_ORDER,
  LOCAL_CONTROL_REASSERT_MS,
  LOCAL_CONTROL_RETRY_MS,
  BELT_TRACKING_ON_MEMBERS,
  type LocalControlSts,
  type LocalControlOutcome,
  type LocalControlDeps,
  type PlcRetractOps,
  type WriteTarget,
} from '@/lib/vfd-validation-writer'
import { PlcTagStatus } from '@/lib/plc'

const OK = PlcTagStatus.PLCTAG_STATUS_OK
const BAD_PARAM = PlcTagStatus.PLCTAG_ERR_BAD_PARAM
const NOW = 1_800_000_000_000

/** A stopped, fully-enabled AOI222 drive. */
function sts(over: Partial<LocalControlSts> = {}): LocalControlSts {
  return { checkAllowed: 1, validMap: 1, validHp: 1, beltTrackingOn: 0, rvs: 0, ...over }
}

// ── The decision ───────────────────────────────────────────────────

describe('planLocalControlRestore — the keypad enable', () => {
  it('untracked + Valid_HP=0 → pulses Valid_Map THEN Valid_HP THEN the invalidate', () => {
    // Order is ladder-mandated. rung 1:
    //   XIC(Check_Allowed) XIC(CMD.Valid_Map) ONS OTL(Valid_Map)
    //   XIC(Valid_Map)     XIC(CMD.Valid_HP)  ONS OTL(Valid_HP)
    // Valid_HP can only latch once Valid_Map already has.
    const plan = planLocalControlRestore(sts({ validMap: 0, validHp: 0 }))
    expect(plan.action).toBe('restore')
    expect(plan.writes).toEqual(['Valid_Map', 'Valid_HP', 'Invalidate_Tracking_Finished'])
  })

  it('Valid_Map already latched, Valid_HP dead → skips the map pulse, keeps the order', () => {
    const plan = planLocalControlRestore(sts({ validMap: 1, validHp: 0 }))
    expect(plan.writes).toEqual(['Valid_HP', 'Invalidate_Tracking_Finished'])
    expect(plan.reason).toMatch(/keypad was DEAD/i)
  })

  it('untracked + already enabled → ONLY the invalidate', () => {
    // Tracking_Finished is a LocalTag with ExternalAccess="None": unreadable.
    // It is an OTU, so a redundant pulse is a genuine ladder no-op — which is
    // exactly what makes level-based reconciliation safe here.
    const plan = planLocalControlRestore(sts())
    expect(plan.action).toBe('restore')
    expect(plan.writes).toEqual(['Invalidate_Tracking_Finished'])
    expect(plan.reason).toMatch(/already enabled/i)
  })

  it('a RUNNING belt defers EVERYTHING — not just the invalidate', () => {
    // rung 7 is UNCONDITIONAL: [XIO(Reverse_Polarity) OTE(DirectionCmd_0),
    // XIC(Reverse_Polarity) OTE(DirectionCmd_1)]. Clearing the latch on a
    // moving belt reverses it under power.
    const plan = planLocalControlRestore(sts({ beltTrackingOn: 1, rvs: 42, validHp: 0 }))
    expect(plan.action).toBe('defer')
    expect(plan.writes).toEqual([])
  })

  it('defers on a nonzero commanded velocity even with belt tracking off', () => {
    expect(planLocalControlRestore(sts({ rvs: 30 })).action).toBe('defer')
  })

  it('tolerates float noise around zero', () => {
    expect(planLocalControlRestore(sts({ rvs: -0.01 })).action).toBe('restore')
  })

  it('DEFERS when stopped-ness is unprovable — neither STS member readable', () => {
    const plan = planLocalControlRestore(sts({ beltTrackingOn: null }))
    expect(plan.action).toBe('defer')
    expect(plan.reason).toMatch(/cannot prove the drive is stopped/i)
  })

  it('DEFERS when STS.RVS is unreadable', () => {
    expect(planLocalControlRestore(sts({ rvs: null })).action).toBe('defer')
  })

  it('DEFERS when STS.Valid_HP itself is unreadable', () => {
    const plan = planLocalControlRestore(sts({ validHp: null }))
    expect(plan.action).toBe('defer')
    expect(plan.reason).toMatch(/Valid_HP unreadable/i)
  })

  it('DEFERS when Valid_Map is unreadable and Valid_HP is not already set', () => {
    expect(planLocalControlRestore(sts({ validMap: null, validHp: 0 })).action).toBe('defer')
  })

  it('proceeds when Valid_Map is unreadable but Valid_HP already reads 1', () => {
    // Valid_HP cannot latch without Valid_Map, so a live keypad is proof
    // enough; an unreadable Valid_Map is not a blocker there.
    const plan = planLocalControlRestore(sts({ validMap: null }))
    expect(plan.action).toBe('restore')
    expect(plan.writes).toEqual(['Invalidate_Tracking_Finished'])
  })

  it('SKIPS when Check_Allowed=0 — drive comms faulted, do not fight it', () => {
    const plan = planLocalControlRestore(sts({ checkAllowed: 0, validMap: 0, validHp: 0 }))
    expect(plan.action).toBe('skip')
    expect(plan.writes).toEqual([])
    expect(plan.reason).toMatch(/Check_Allowed=0/)
  })

  it('SKIPS when Check_Allowed is unreadable and we need to latch Valid_Map', () => {
    expect(planLocalControlRestore(sts({ checkAllowed: null, validMap: 0, validHp: 0 })).action).toBe('skip')
  })

  it('ignores Check_Allowed when nothing needs latching', () => {
    // Nothing to latch → rung 1 is irrelevant → a low permissive must not stop
    // us handing direction back.
    const plan = planLocalControlRestore(sts({ checkAllowed: 0 }))
    expect(plan.action).toBe('restore')
    expect(plan.writes).toEqual(['Invalidate_Tracking_Finished'])
  })

  it('never emits a disabling bit under any input combination', () => {
    const values: Array<number | null> = [0, 1, null]
    for (const checkAllowed of values) {
      for (const validMap of values) {
        for (const validHp of values) {
          for (const beltTrackingOn of values) {
            for (const rvs of [0, 30, null] as Array<number | null>) {
              const plan = planLocalControlRestore({ checkAllowed, validMap, validHp, beltTrackingOn, rvs })
              for (const field of plan.writes) {
                // Invalidate_HP / Invalidate_Map are what DISABLE the keypad.
                expect(field).not.toMatch(/Invalidate_HP|Invalidate_Map|Stop_Belt_Tracking/)
                expect(LOCAL_CONTROL_WRITE_ORDER).toContain(field)
              }
              // Motion is an absolute bar.
              if (beltTrackingOn !== 0 || rvs === null || (rvs !== null && Math.abs(rvs) >= 0.5)) {
                expect(plan.writes).toEqual([])
              }
            }
          }
        }
      }
    }
  })
})

// ── Against a fake controller ──────────────────────────────────────

interface FakeCall { op: string; tag: string; value?: number }

/**
 * Fake PlcRetractOps. `values` supplies STS by member name; a member absent
 * from it answers BAD_PARAM at createTag — the real signature for an AOI
 * member that is not in the downloaded program — so "a missing member must not
 * throw" is genuinely exercised.
 */
function fakeOps(
  values: Record<string, number>,
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
      if (tag.includes('.CTRL.STS.') && !(member in values)) return { handle: -1, status: BAD_PARAM }
      const handle = nextHandle++
      handles.set(handle, { tag, value: values[member] ?? 0 })
      return { handle, status: OK }
    },
    readTagAsync: async (handle) => {
      calls.push({ op: 'read', tag: handles.get(handle)?.tag ?? '?' })
      return OK
    },
    writeTagAsync: async (handle) => {
      const h = handles.get(handle)!
      calls.push({ op: 'write', tag: h.tag, value: h.value })
      return h.tag.endsWith(opts.failWrite ?? ' ') ? PlcTagStatus.PLCTAG_ERR_TIMEOUT : OK
    },
    getBit: (handle) => (handles.get(handle)!.value !== 0 ? 1 : 0),
    getFloat32: (handle) => handles.get(handle)!.value,
    setInt8: (handle, _offset, value) => { handles.get(handle)!.value = value; return OK },
    destroy: (handle) => {
      calls.push({ op: 'destroy', tag: handles.get(handle)?.tag ?? '?' })
      handles.delete(handle)
    },
  }
  return { ops, calls }
}

/** A stopped AOI222 drive whose keypad is DEAD. */
const DEAD_KEYPAD_AOI222 = { Check_Allowed: 1, Valid_Map: 0, Valid_HP: 0, Belt_Tracking_ON: 0, RVS: 0 }
/** A stopped AOI222 drive that is already fully enabled. */
const ENABLED_AOI222 = { Check_Allowed: 1, Valid_Map: 1, Valid_HP: 1, Belt_Tracking_ON: 0, RVS: 0 }

const cmdWrites = (calls: FakeCall[]) =>
  calls.filter(c => c.op === 'write' && c.tag.includes('.CTRL.CMD.')).map(c => c.tag)

describe('restoreLocalControlOnFfi', () => {
  it('dead keypad → writes Valid_Map, Valid_HP, Invalidate_Tracking_Finished IN THAT ORDER', async () => {
    const { ops, calls } = fakeOps(DEAD_KEYPAD_AOI222)
    const outcome = await restoreLocalControlOnFfi(ops, '10.0.0.1', '1,0', 'UL9_9_VFD1')
    expect(outcome.action).toBe('restore')
    expect(cmdWrites(calls)).toEqual([
      'CBT_UL9_9_VFD1.CTRL.CMD.Valid_Map',
      'CBT_UL9_9_VFD1.CTRL.CMD.Valid_HP',
      'CBT_UL9_9_VFD1.CTRL.CMD.Invalidate_Tracking_Finished',
    ])
    expect(outcome.written).toEqual([...LOCAL_CONTROL_WRITE_ORDER])
  })

  it('already enabled → issues ONLY the invalidate', async () => {
    const { ops, calls } = fakeOps(ENABLED_AOI222)
    const outcome = await restoreLocalControlOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    expect(outcome.written).toEqual(['Invalidate_Tracking_Finished'])
    expect(cmdWrites(calls)).toEqual(['CBT_D1.CTRL.CMD.Invalidate_Tracking_Finished'])
  })

  it('every write is a pulse of 1 — rung 8 FLLs CMD to 0 each scan, so 0 is meaningless', async () => {
    const { ops, calls } = fakeOps(DEAD_KEYPAD_AOI222)
    await restoreLocalControlOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    expect(calls.filter(c => c.op === 'write' && c.tag.includes('.CMD.')).every(c => c.value === 1)).toBe(true)
  })

  it('NEVER sends Invalidate_HP, Invalidate_Map or the dead Stop_Belt_Tracking tag', async () => {
    const { ops, calls } = fakeOps(DEAD_KEYPAD_AOI222)
    await restoreLocalControlOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    expect(calls.some(c => c.tag.includes('Invalidate_HP'))).toBe(false)
    expect(calls.some(c => c.tag.includes('Invalidate_Map'))).toBe(false)
    expect(calls.some(c => c.tag.includes('Stop_Belt_Tracking'))).toBe(false)
  })

  it('a RUNNING belt gets ZERO CMD writes', async () => {
    const { ops, calls } = fakeOps({ ...DEAD_KEYPAD_AOI222, Belt_Tracking_ON: 1, RVS: 55 })
    const outcome = await restoreLocalControlOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    expect(outcome.action).toBe('defer')
    expect(cmdWrites(calls)).toEqual([])
  })

  it('Check_Allowed=0 gets ZERO CMD writes and reports skip', async () => {
    const { ops, calls } = fakeOps({ ...DEAD_KEYPAD_AOI222, Check_Allowed: 0 })
    const outcome = await restoreLocalControlOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    expect(outcome.action).toBe('skip')
    expect(cmdWrites(calls)).toEqual([])
  })

  it('ABORTS the sequence if a write fails — no invalidate behind an unlatched Valid_HP', async () => {
    const { ops, calls } = fakeOps(DEAD_KEYPAD_AOI222, { failWrite: 'Valid_HP' })
    const outcome = await restoreLocalControlOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    expect(outcome.action).toBe('failed')
    expect(outcome.written).toEqual(['Valid_Map'])
    expect(cmdWrites(calls)).not.toContain('CBT_D1.CTRL.CMD.Invalidate_Tracking_Finished')
  })

  it('destroys every handle it opens', async () => {
    const { ops, calls } = fakeOps(DEAD_KEYPAD_AOI222)
    await restoreLocalControlOnFfi(ops, '10.0.0.1', '1,0', 'D1')
    // A BAD_PARAM create yields handle -1, which is not destroyable — exclude
    // the probe for the AOI member this revision doesn't have.
    const created = calls.filter(c => c.op === 'create' && !c.tag.endsWith('.STS.Track_Belt')).length
    expect(calls.filter(c => c.op === 'destroy').length).toBe(created)
  })
})

describe('readLocalControlSts — two AOI revisions', () => {
  it('reads Belt_Tracking_ON on AOI222', async () => {
    const { ops } = fakeOps(ENABLED_AOI222)
    expect(await readLocalControlSts(ops, 'g', 'p', 'D1')).toEqual({
      checkAllowed: 1, validMap: 1, validHp: 1, beltTrackingOn: 0, rvs: 0,
    })
  })

  it('falls back to Track_Belt on the older AOI rev — a missing member must not throw', async () => {
    const { ops, calls } = fakeOps({ Check_Allowed: 1, Valid_Map: 1, Valid_HP: 0, Track_Belt: 0, RVS: 0 })
    const snapshot = await readLocalControlSts(ops, 'g', 'p', 'D1')
    expect(snapshot.beltTrackingOn).toBe(0)
    expect(snapshot.validHp).toBe(0)
    expect(calls.some(c => c.tag.endsWith('.STS.Belt_Tracking_ON'))).toBe(true)
    expect(calls.some(c => c.tag.endsWith('.STS.Track_Belt'))).toBe(true)
    // …and the older revision still gets its keypad back.
    expect(planLocalControlRestore(snapshot).writes).toEqual(['Valid_HP', 'Invalidate_Tracking_Finished'])
  })

  it('reports null → defer when NEITHER member exists', async () => {
    const { ops } = fakeOps({ Check_Allowed: 1, Valid_Map: 1, Valid_HP: 1, RVS: 0 })
    const snapshot = await readLocalControlSts(ops, 'g', 'p', 'D1')
    expect(snapshot.beltTrackingOn).toBeNull()
    expect(planLocalControlRestore(snapshot).action).toBe('defer')
  })

  it('probes both known member names', () => {
    expect([...BELT_TRACKING_ON_MEMBERS]).toEqual(['Belt_Tracking_ON', 'Track_Belt'])
  })
})

describe('restoreLocalControlOnRemote', () => {
  const base = 'CBT_D1.CTRL.STS.'

  function remoteIo(values: Record<string, unknown>) {
    const written: string[] = []
    return {
      written,
      io: {
        readTyped: async (_sid: string, reads: Array<{ name: string }>) => ({
          connected: true,
          results: reads.map(r => {
            const member = r.name.slice(base.length)
            return member in values
              ? { success: true, value: values[member] }
              : { success: false, error: 'bad parameter' }
          }),
        }),
        writeTyped: async (_sid: string, writes: Array<{ name: string; value: number }>) => {
          for (const w of writes) written.push(`${w.name}=${w.value}`)
          return { connected: true, results: writes.map(() => ({ success: true })) }
        },
      },
    }
  }

  it('dead keypad → same three writes, same order, one batch each', async () => {
    const { io, written } = remoteIo({ Check_Allowed: true, Valid_Map: false, Valid_HP: false, Belt_Tracking_ON: false, RVS: 0 })
    const outcome = await restoreLocalControlOnRemote('42', 'D1', io)
    expect(outcome.action).toBe('restore')
    expect(written).toEqual([
      'CBT_D1.CTRL.CMD.Valid_Map=1',
      'CBT_D1.CTRL.CMD.Valid_HP=1',
      'CBT_D1.CTRL.CMD.Invalidate_Tracking_Finished=1',
    ])
  })

  it('running belt defers with zero writes', async () => {
    const { io, written } = remoteIo({ Check_Allowed: true, Valid_Map: false, Valid_HP: false, Belt_Tracking_ON: true, RVS: 60 })
    expect((await restoreLocalControlOnRemote('42', 'D1', io)).action).toBe('defer')
    expect(written).toEqual([])
  })

  it('defers when the MCM is not connected', async () => {
    const io = {
      readTyped: async () => ({ connected: false, results: [] }),
      writeTyped: async () => ({ connected: false, results: [] }),
    }
    expect((await restoreLocalControlOnRemote('42', 'D1', io)).action).toBe('defer')
  })
})

// ── The pass: freshness, tracked belts, rate limiting ──────────────

function target(over: Partial<WriteTarget> = {}): WriteTarget {
  return {
    kind: 'ffi',
    label: 'mcm-42',
    ip: '10.0.0.1',
    path: '1,0',
    subsystemId: '42',
    isConnected: () => true,
    readTagCached: () => null,
    devices: [],
    ...over,
  }
}

function spyDeps(): { deps: LocalControlDeps; seen: string[] } {
  const seen: string[] = []
  const outcome = (deviceName: string): LocalControlOutcome =>
    ({ deviceName, action: 'restore', reason: 'test', written: ['Invalidate_Tracking_Finished'] })
  return {
    seen,
    deps: {
      restoreOnFfi: async (_g, _p, name) => { seen.push(`ffi:${name}`); return outcome(name) },
      restoreOnRemote: async (_s, name) => { seen.push(`remote:${name}`); return outcome(name) },
    },
  }
}

describe('runLocalControlRestorePass', () => {
  beforeEach(() => resetLocalControlBackoff())

  const routes = new Map([['BELT_A', '42'], ['BELT_B', '42']])
  const fresh = new Map([['42', true]])

  it('reconciles every untracked belt, every sweep — no edge required', async () => {
    const { deps, seen } = spyDeps()
    await runLocalControlRestorePass([target()], fresh, new Set(['BELT_A', 'BELT_B']), routes, NOW, deps)
    expect(seen).toEqual(['ffi:BELT_A', 'ffi:BELT_B'])
  })

  it('a STALE instance does NOTHING — silence is the safe failure', async () => {
    const { deps, seen } = spyDeps()
    await runLocalControlRestorePass(
      [target()], new Map([['42', false]]), new Set(['BELT_A']), routes, NOW, deps,
    )
    expect(seen).toEqual([])
  })

  it('FAILS CLOSED on a missing freshness verdict — an unjudged instance stays quiet', async () => {
    const { deps, seen } = spyDeps()
    await runLocalControlRestorePass([target()], new Map(), new Set(['BELT_A']), routes, NOW, deps)
    expect(seen).toEqual([])
  })

  it('a TRACKED belt is never touched — it is simply not in the untracked set', async () => {
    const { deps, seen } = spyDeps()
    // BELT_B is tracked, so only BELT_A reaches the pass.
    await runLocalControlRestorePass([target()], fresh, new Set(['BELT_A']), routes, NOW, deps)
    expect(seen).toEqual(['ffi:BELT_A'])
    expect(seen.some(s => s.includes('BELT_B'))).toBe(false)
  })

  it('does nothing at all when no belt is untracked', async () => {
    const { deps, seen } = spyDeps()
    expect(await runLocalControlRestorePass([target()], fresh, new Set(), routes, NOW, deps)).toEqual([])
    expect(seen).toEqual([])
  })

  it('skips a disconnected FFI target without burning the backoff', async () => {
    const { deps, seen } = spyDeps()
    await runLocalControlRestorePass(
      [target({ isConnected: () => false })], fresh, new Set(['BELT_A']), routes, NOW, deps,
    )
    expect(seen).toEqual([])
    expect(isLocalControlDue('BELT_A', NOW)).toBe(true)
  })

  it('routes a remote (gateway) target through the remote path', async () => {
    const { deps, seen } = spyDeps()
    await runLocalControlRestorePass(
      [target({ kind: 'remote' })], fresh, new Set(['BELT_A']), routes, NOW, deps,
    )
    expect(seen).toEqual(['remote:BELT_A'])
  })

  it('falls back to the legacy active singleton for an unmapped device', async () => {
    const { deps, seen } = spyDeps()
    await runLocalControlRestorePass(
      [target({ label: 'active-plc', subsystemId: undefined })],
      new Map([['active', true]]), new Set(['ORPHAN']), new Map(), NOW, deps,
    )
    expect(seen).toEqual(['ffi:ORPHAN'])
  })

  it('does nothing when no connected controller owns the device', async () => {
    const { deps, seen } = spyDeps()
    await runLocalControlRestorePass([], fresh, new Set(['BELT_A']), routes, NOW, deps)
    expect(seen).toEqual([])
  })
})

describe('runLocalControlRestorePass — rate limiting', () => {
  beforeEach(() => resetLocalControlBackoff())

  const routes = new Map([['BELT_A', '42']])
  const fresh = new Map([['42', true]])

  it('does not re-probe a converged device on the very next sweep', async () => {
    // The latch is UNREADABLE, so we can never confirm success — the limiter is
    // what stops this pulsing the shared controller every 5 minutes forever.
    const { deps, seen } = spyDeps()
    const untracked = new Set(['BELT_A'])
    await runLocalControlRestorePass([target()], fresh, untracked, routes, NOW, deps)
    await runLocalControlRestorePass([target()], fresh, untracked, routes, NOW + 5 * 60_000, deps)
    expect(seen).toEqual(['ffi:BELT_A'])
  })

  it('re-asserts once the reassert window elapses', async () => {
    const { deps, seen } = spyDeps()
    const untracked = new Set(['BELT_A'])
    await runLocalControlRestorePass([target()], fresh, untracked, routes, NOW, deps)
    await runLocalControlRestorePass([target()], fresh, untracked, routes, NOW + LOCAL_CONTROL_REASSERT_MS, deps)
    expect(seen).toEqual(['ffi:BELT_A', 'ffi:BELT_A'])
  })

  it('a DEFERRED (running) belt retries on the short window, not the long one', async () => {
    // A belt that stops must get its keypad back in minutes, not half an hour.
    const seen: string[] = []
    const deps: LocalControlDeps = {
      restoreOnFfi: async (_g, _p, name) => {
        seen.push(name)
        return { deviceName: name, action: 'defer', reason: 'running', written: [] }
      },
      restoreOnRemote: async (_s, name) => ({ deviceName: name, action: 'defer', reason: 'running', written: [] }),
    }
    const untracked = new Set(['BELT_A'])
    await runLocalControlRestorePass([target()], fresh, untracked, routes, NOW, deps)
    expect(isLocalControlDue('BELT_A', NOW + LOCAL_CONTROL_RETRY_MS - 1)).toBe(false)
    await runLocalControlRestorePass([target()], fresh, untracked, routes, NOW + LOCAL_CONTROL_RETRY_MS, deps)
    expect(seen).toEqual(['BELT_A', 'BELT_A'])
    expect(LOCAL_CONTROL_RETRY_MS).toBeLessThan(LOCAL_CONTROL_REASSERT_MS)
  })

  it('a re-tracked belt loses its backoff, so a later untrack acts IMMEDIATELY', async () => {
    const { deps, seen } = spyDeps()
    await runLocalControlRestorePass([target()], fresh, new Set(['BELT_A']), routes, NOW, deps)
    // Mech tracks it again → it leaves the untracked set → memo pruned.
    await runLocalControlRestorePass([target()], fresh, new Set(), routes, NOW + 1000, deps)
    // …then untracks it again a minute later, well inside the reassert window.
    await runLocalControlRestorePass([target()], fresh, new Set(['BELT_A']), routes, NOW + 60_000, deps)
    expect(seen).toEqual(['ffi:BELT_A', 'ffi:BELT_A'])
  })

  it('resetLocalControlBackoff (PLC reconnect / program download) makes everything due again', async () => {
    const { deps, seen } = spyDeps()
    const untracked = new Set(['BELT_A'])
    await runLocalControlRestorePass([target()], fresh, untracked, routes, NOW, deps)
    expect(isLocalControlDue('BELT_A', NOW + 1000)).toBe(false)
    // A download drops Valid_Map/Valid_HP — the keypad may have just died.
    resetLocalControlBackoff()
    expect(isLocalControlDue('BELT_A', NOW + 1000)).toBe(true)
    await runLocalControlRestorePass([target()], fresh, untracked, routes, NOW + 1000, deps)
    expect(seen).toEqual(['ffi:BELT_A', 'ffi:BELT_A'])
  })

  it('the default cadence is conservative on a shared controller', () => {
    expect(LOCAL_CONTROL_REASSERT_MS).toBe(30 * 60_000)
    expect(LOCAL_CONTROL_RETRY_MS).toBe(60_000)
  })
})
