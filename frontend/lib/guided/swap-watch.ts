/**
 * Live swap / wrong-wiring detection for guided IO checks.
 *
 * While an io_check step waits for the EXPECTED IO to complete its D6
 * round-trip, every other untested IO in the subsystem is a swap candidate:
 * if one of them completes a full round-trip (actuate + return, anchored at
 * its first-seen state) while the expected point never left idle, the wiring
 * for the device the tester just actuated almost certainly lands on that
 * other point. The runner surfaces a banner; the tester must still ACCEPT
 * the fail (spec: "user should still need to accept the fail").
 *
 * Detection is a full round-trip — not a single transition — so background
 * flaps and static states never fire it, matching the D6 semantics used for
 * the expected IO itself. Each candidate reports at most once per step; a
 * dismissed candidate can be re-armed.
 *
 * Pure module: no DB/PLC/WS access. The runner feeds IOUpdate events in.
 */

import {
  advanceRoundTrip,
  classifyIoCircuit,
  startRoundTrip,
  type RoundTrip,
  type TagState,
} from './io-check-sequence'

export interface SwapCandidateIo {
  id: number
  name: string
  description?: string | null
}

export interface SwapSuspicion {
  ioId: number
  ioName: string
  /** True when the triggered point is a SPARE — per spare semantics an
   *  unexpected live state on a SPARE is itself wrong wiring. */
  spare: boolean
  /** 'high' when the triggered point belongs to the same device the tester
   *  is standing at (classic adjacent-terminal swap); 'low' otherwise. */
  confidence: 'high' | 'low'
  suggestedComment: string
}

export interface SwapWatch {
  /** Feed one live transition. Returns a suspicion when an unexpected
   *  candidate completes its full round-trip, else null. */
  feed(ioId: number, state: TagState): SwapSuspicion | null
  /** Re-arm a candidate after the operator dismisses a banner. */
  rearm(ioId: number): void
}

export function isSpareIo(description?: string | null): boolean {
  return (description ?? '').toUpperCase().includes('SPARE')
}

/**
 * Build the suggested punchlist comment for an accepted swap. Mirrors the
 * wording of the (previously orphaned) swap-detection service so cloud-side
 * readers see a consistent format.
 */
export function swapComment(expectedLabel: string, actual: SwapCandidateIo): string {
  const actualLabel = actual.description || actual.name
  const spareNote = isSpareIo(actual.description) ? ' (SPARE point — must not be wired)' : ''
  return `Swap detected: expected "${expectedLabel}" but "${actualLabel}" triggered instead${spareNote}`
}

/** Comment recorded on the SPARE point itself when the operator accepts. */
export function spareHitComment(expectedLabel: string): string {
  return `Unexpected signal while checking "${expectedLabel}" — SPARE point is wired (wrong wiring)`
}

/**
 * Create a watcher for one io_check step.
 *
 * @param candidates untested IOs of the subsystem, EXCLUDING the expected
 *                   (watched) IO ids of the current step.
 * @param deviceName the current task's device — used for confidence scoring.
 */
export function createSwapWatch(
  candidates: SwapCandidateIo[],
  deviceName?: string | null,
): SwapWatch {
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const trips = new Map<number, RoundTrip>()
  const dev = (deviceName ?? '').toUpperCase()

  function suspicionFor(c: SwapCandidateIo): SwapSuspicion {
    const hay = `${c.name} ${c.description ?? ''}`.toUpperCase()
    return {
      ioId: c.id,
      ioName: c.name,
      spare: isSpareIo(c.description),
      confidence: dev && hay.includes(dev) ? 'high' : 'low',
      suggestedComment: '', // composed by the caller with the expected label
    }
  }

  return {
    feed(ioId, state) {
      const c = byId.get(ioId)
      if (!c) return null
      // Anchor at the circuit's KNOWN idle (NC rests TRUE, NO rests FALSE).
      // The tag reader broadcasts CHANGES only, so the first event we see for
      // a swapped point is already the actuation — anchoring at first-seen
      // state would swallow one full physical actuation before reporting.
      const rt = trips.get(ioId) ?? startRoundTrip(classifyIoCircuit(c.name, c.description))
      const next = advanceRoundTrip(rt, state)
      trips.set(ioId, next)
      if (next.phase !== 'complete') return null
      // Report once: drop the candidate so a flapping point can't re-fire
      // (rearm() restores it after an explicit dismiss).
      byId.delete(ioId)
      return suspicionFor(c)
    },
    rearm(ioId) {
      const c = candidates.find((x) => x.id === ioId)
      if (c) {
        byId.set(ioId, c)
        trips.delete(ioId)
      }
    },
  }
}
