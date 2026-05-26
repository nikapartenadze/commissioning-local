import { describe, it, expect } from 'vitest'
import {
  connectionVerdict,
  INITIAL_CONNECTION_STATE,
  CONNECTION_LOSS_MIN_CYCLES,
  CONNECTION_LOSS_MIN_MS,
  type ConnectionEvalState,
} from '@/lib/plc/connection-verdict'

const S = () => ({ ...INITIAL_CONNECTION_STATE })

describe('connectionVerdict — false-disconnect prevention', () => {
  it('keeps the connection up when ANY read succeeds, even if most fail', () => {
    // 10 fail, 1 succeed — old code (success>fail) would call this a bad cycle.
    let r = connectionVerdict(S(), 1, 10, 1_000)
    expect(r.state.isConnected).toBe(true)
    expect(r.state.totalFailureCycles).toBe(0)
    expect(r.changedTo).toBeUndefined()
  })

  it('does NOT disconnect on a single total-failure cycle', () => {
    const r = connectionVerdict(S(), 0, 50, 1_000)
    expect(r.state.isConnected).toBe(true)
    expect(r.state.totalFailureCycles).toBe(1)
    expect(r.changedTo).toBeUndefined()
  })

  it('does NOT disconnect on a fast burst of total failures under the time window', () => {
    // 5 total-failure cycles in 1 second — exceeds the cycle count but not the
    // time window, so a sub-second blip must not tear down the connection.
    let state: ConnectionEvalState = S()
    let lastChange: boolean | undefined
    for (let i = 0; i < 5; i++) {
      const r = connectionVerdict(state, 0, 50, 1_000 + i * 100) // 100ms apart
      state = r.state
      lastChange = r.changedTo
    }
    expect(state.isConnected).toBe(true)
    expect(lastChange).toBeUndefined()
  })

  it('declares the PLC lost only after sustained total failure (cycles AND time)', () => {
    let state: ConnectionEvalState = S()
    let disconnectedAt: number | null = null
    // One total-failure cycle every 2 seconds.
    for (let i = 0; i < 5; i++) {
      const t = 1_000 + i * 2_000
      const r = connectionVerdict(state, 0, 50, t)
      state = r.state
      if (r.changedTo === false) disconnectedAt = t
    }
    expect(state.isConnected).toBe(false)
    expect(disconnectedAt).not.toBeNull()
    // Must have satisfied both thresholds.
    expect(state.totalFailureCycles).toBeGreaterThanOrEqual(CONNECTION_LOSS_MIN_CYCLES)
    expect(disconnectedAt! - 1_000).toBeGreaterThanOrEqual(CONNECTION_LOSS_MIN_MS)
  })

  it('emits the disconnect transition exactly once, not on every later failure', () => {
    let state: ConnectionEvalState = S()
    const changes: Array<boolean | undefined> = []
    for (let i = 0; i < 8; i++) {
      const r = connectionVerdict(state, 0, 50, 1_000 + i * 2_000)
      state = r.state
      changes.push(r.changedTo)
    }
    expect(changes.filter((c) => c === false)).toHaveLength(1)
  })

  it('reconnects (emits true) when a read succeeds after being disconnected', () => {
    const disconnected: ConnectionEvalState = { isConnected: false, totalFailureCycles: 9, firstFailureAt: 1_000 }
    const r = connectionVerdict(disconnected, 5, 0, 99_000)
    expect(r.state.isConnected).toBe(true)
    expect(r.state.totalFailureCycles).toBe(0)
    expect(r.state.firstFailureAt).toBe(0)
    expect(r.changedTo).toBe(true)
  })

  it('a success mid-streak resets the streak so the timer starts fresh', () => {
    let state: ConnectionEvalState = S()
    state = connectionVerdict(state, 0, 50, 1_000).state // fail
    state = connectionVerdict(state, 0, 50, 3_000).state // fail
    expect(state.totalFailureCycles).toBe(2)
    state = connectionVerdict(state, 1, 49, 4_000).state // one success → reset
    expect(state.totalFailureCycles).toBe(0)
    expect(state.firstFailureAt).toBe(0)
    expect(state.isConnected).toBe(true)
  })

  it('treats an empty cycle (nothing attempted) as no signal', () => {
    const prev: ConnectionEvalState = { isConnected: true, totalFailureCycles: 2, firstFailureAt: 1_000 }
    const r = connectionVerdict(prev, 0, 0, 9_999)
    expect(r.state).toEqual(prev) // unchanged
    expect(r.changedTo).toBeUndefined()
  })
})
