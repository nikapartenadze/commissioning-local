/**
 * Regression: a WebSocket RECONNECT must never forge a passing IO check.
 *
 * The server replays a `TagSnapshot` of cached tag states on every WS connect
 * (server-express.ts), the browser client fans each entry out as a synthetic
 * per-IO update (lib/plc/websocket-client.ts), and the guided round-trip
 * tracker is deliberately time-blind — `advanceRoundTrip` sees only states.
 *
 * Before the guard, a mid-check network blip replayed the stale pre-actuation
 * state, the tracker read it as "the tester returned the device to rest", and
 * guided mode auto-recorded Passed for an IO nobody finished checking — with
 * the PLC not necessarily even connected.
 *
 * These tests pin the invariant at the only place it can be enforced: the feed
 * site must reject cached replays BEFORE they reach the state machine.
 */
import { describe, it, expect } from 'vitest'
import {
  advanceRoundTrip,
  canAdvanceRoundTrip,
  startRoundTrip,
} from '@/lib/guided/io-check-sequence'

/** Shape of a tag event as the runner receives it (subset of IOUpdate). */
type TagEvent = { State: 'TRUE' | 'FALSE'; FromSnapshot?: boolean }

describe('canAdvanceRoundTrip — freshness gate', () => {
  it('rejects a snapshot replay', () => {
    expect(canAdvanceRoundTrip({ FromSnapshot: true })).toBe(false)
  })

  it('accepts a live transition', () => {
    expect(canAdvanceRoundTrip({ FromSnapshot: false })).toBe(true)
    // A live UpdateState frame carries no FromSnapshot field at all.
    expect(canAdvanceRoundTrip({})).toBe(true)
  })

  it('fails CLOSED — only an explicit false/absent flag is treated as live', () => {
    expect(canAdvanceRoundTrip({ FromSnapshot: true })).toBe(false)
  })
})

describe('the attack the gate prevents', () => {
  /** NC device: rests TRUE, blocked = FALSE, cleared = TRUE. */
  it('WITHOUT the gate, two replayed frames complete a round trip', () => {
    // Tester blocks the photoeye — tracker is armed and awaiting the return.
    let rt = startRoundTrip(null)
    rt = advanceRoundTrip(rt, 'TRUE') // anchor idle, arm
    rt = advanceRoundTrip(rt, 'FALSE') // blocked
    expect(rt.phase).toBe('await_return')

    // Network blip. Reconnect replays the CACHED pre-block TRUE. The tracker
    // has no way to know this is stale — it completes.
    rt = advanceRoundTrip(rt, 'TRUE')
    expect(rt.phase).toBe('complete') // ← would have auto-passed

    // This is why the gate cannot live inside advanceRoundTrip: by the time a
    // state reaches it, freshness is unknowable.
  })

  it('WITH the gate, the replayed frame is dropped and the check stays open', () => {
    let rt = startRoundTrip(null)
    rt = advanceRoundTrip(rt, 'TRUE')
    rt = advanceRoundTrip(rt, 'FALSE')
    expect(rt.phase).toBe('await_return')

    const replay: TagEvent = { State: 'TRUE', FromSnapshot: true }
    if (canAdvanceRoundTrip(replay)) rt = advanceRoundTrip(rt, replay.State)

    expect(rt.phase).toBe('await_return') // still waiting on a REAL clear
  })

  it('a genuine clear after a dropped replay still passes', () => {
    let rt = startRoundTrip(null)
    rt = advanceRoundTrip(rt, 'TRUE')
    rt = advanceRoundTrip(rt, 'FALSE')

    const replay: TagEvent = { State: 'TRUE', FromSnapshot: true }
    if (canAdvanceRoundTrip(replay)) rt = advanceRoundTrip(rt, replay.State)
    expect(rt.phase).toBe('await_return')

    const live: TagEvent = { State: 'TRUE' }
    if (canAdvanceRoundTrip(live)) rt = advanceRoundTrip(rt, live.State)
    expect(rt.phase).toBe('complete') // the tester's real clear still works
  })

  it('a snapshot cannot arm a fresh check either (two-frame completion)', () => {
    // From `arming`, a state away from idle jumps straight to await_return —
    // so two snapshot frames alone could complete a check on a step the tester
    // had only just opened.
    let rt = startRoundTrip(null)
    const frames: TagEvent[] = [
      { State: 'FALSE', FromSnapshot: true },
      { State: 'TRUE', FromSnapshot: true },
    ]
    for (const f of frames) {
      if (canAdvanceRoundTrip(f)) rt = advanceRoundTrip(rt, f.State)
    }
    expect(rt.phase).toBe('arming') // nothing moved
  })
})
