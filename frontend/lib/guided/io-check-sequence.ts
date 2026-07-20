/**
 * IO-check round-trip sequencing + NC/NO circuit classification.
 *
 * Committee decision D6 (Guided Mode, 2026-06): an IO check passes only on the
 * FULL actuation sequence, not the first transition:
 *
 *   - NC devices (photoeyes, e-stops / EPCs, pull cords — nominally TRUE):
 *     TRUE → FALSE → TRUE   (block then clear, pull then reset)
 *   - NO devices (pushbuttons, etc. — nominally FALSE):
 *     FALSE → TRUE → FALSE  (press then release)
 *
 * and an IO-check item cannot enter the queue unless its pre-check passes:
 * NC devices must already read TRUE (nominal) in the tool. A NC point reading
 * FALSE at rest is a misconfigured/miswired device — surfacing that is the
 * point of the rule.
 *
 * Pure module — used by the snapshot builder (pre-check gating), the step
 * builder (instructions) and the runner (live sequencing). No DB/PLC access.
 */

export type Circuit = 'NC' | 'NO'
export type TagState = 'TRUE' | 'FALSE'

/**
 * Classify an IO point's circuit type from its tag name + description.
 * NC (normally-closed → nominally TRUE): photoeyes, e-stops/EPCs, pull cords,
 * safety inputs. Everything else (pushbuttons, jam-reset buttons, generic
 * discretes) is treated as NO.
 */
export function classifyIoCircuit(name?: string | null, description?: string | null): Circuit {
  const n = name ?? ''
  const d = description ?? ''
  const txt = `${n} ${d}`
  // Photoeyes: PE / TPE / JPE / FPE tokens or the words PHOTO EYE / PHOTOEYE.
  if (/(^|[_:.\s])(J|T|F)?PE\d/i.test(txt)) return 'NC'
  if (/PHOTO\s*-?\s*EYE/i.test(txt)) return 'NC'
  // E-stops / pull cords: EPC tokens, ESTOP, E-STOP, PULL CORD.
  if (/(^|[_:.\s])EPC\d?/i.test(txt)) return 'NC'
  if (/E\s*-?\s*STOP/i.test(txt)) return 'NC'
  if (/PULL\s*-?\s*CORD/i.test(txt)) return 'NC'
  // Safety inputs read through the safety task (`:SI.`) are NC by convention.
  if (/:SI\./i.test(n)) return 'NC'
  return 'NO'
}

/** The state a circuit reads at rest (the pre-check expectation). */
export function expectedIdleState(circuit: Circuit): TagState {
  return circuit === 'NC' ? 'TRUE' : 'FALSE'
}

/**
 * Pre-check (committee D6): NC devices must read TRUE before the check may
 * start. Returns the failure text when the pre-check fails, null when it
 * passes or cannot be evaluated (unknown live state — never block on missing
 * data; that matches the pool's null semantics everywhere else).
 *
 * NO devices have no pre-check — the committee only pinned NC ("PEs, EPCs,
 * etc (NC things) are showing TRUE in the tool").
 */
export function precheckFailure(
  circuit: Circuit,
  liveState: TagState | null | undefined,
  label: string,
): string | null {
  if (circuit !== 'NC') return null
  if (liveState !== 'FALSE') return null // TRUE passes; null/unknown is non-blocking
  return `${label} reads FALSE at rest — NC device must read TRUE (check wiring/configuration)`
}

// ── round-trip state machine ────────────────────────────────────────────────

export type RoundTripPhase =
  /** No live state seen yet. */
  | 'arming'
  /** At idle — waiting for the tester to actuate (block / press / pull). */
  | 'await_actuate'
  /** Actuation seen — waiting for the return to idle (clear / release / reset). */
  | 'await_return'
  /** Full sequence observed — the check passes. */
  | 'complete'

export interface RoundTrip {
  /** The anchor (idle) state transitions are measured against. */
  idle: TagState | null
  phase: RoundTripPhase
}

/**
 * Start a round-trip tracker. When the circuit type is known the idle anchor
 * is its nominal state; otherwise the first live state seen becomes the anchor.
 */
export function startRoundTrip(circuit: Circuit | null): RoundTrip {
  return {
    idle: circuit ? expectedIdleState(circuit) : null,
    phase: 'arming',
  }
}

/**
 * Feed one live state into the tracker, returning the next tracker state.
 *
 * Sequencing rules:
 *  - With no idle anchor yet, the first state seen becomes the anchor.
 *  - At `arming`, a state equal to idle arms the check (await_actuate); a
 *    state already away from idle counts as the actuation having happened
 *    (await_return) — the tester may have actuated before the tool armed.
 *  - `await_actuate` + state ≠ idle → `await_return`.
 *  - `await_return` + state = idle → `complete`.
 */
/**
 * May this tag event drive the round-trip state machine?
 *
 * `advanceRoundTrip` is deliberately time-blind — it sees only states, never
 * timestamps — so freshness MUST be enforced before feeding it. The server
 * replays a `TagSnapshot` of cached tag states on every WebSocket connect
 * (including reconnects), and the tag reader keeps the last-known-good value
 * through a comms outage. A replayed pre-actuation state fed into the tracker
 * reads as "the tester returned the device to rest" and auto-passes an IO that
 * was never actually checked.
 *
 * Rule: only LIVE transitions advance the sequence. Cached replays may update
 * a display, never a verdict.
 */
export function canAdvanceRoundTrip(evt: { FromSnapshot?: boolean }): boolean {
  return evt.FromSnapshot !== true
}

export function advanceRoundTrip(rt: RoundTrip, state: TagState): RoundTrip {
  if (rt.phase === 'complete') return rt
  const idle = rt.idle ?? state
  if (rt.phase === 'arming') {
    return { idle, phase: state === idle ? 'await_actuate' : 'await_return' }
  }
  if (rt.phase === 'await_actuate') {
    return state !== idle ? { idle, phase: 'await_return' } : rt
  }
  // await_return
  return state === idle ? { idle, phase: 'complete' } : rt
}

/** Human wording for the actuate/release halves, by circuit type. */
export function sequenceHint(circuit: Circuit): { actuate: string; release: string } {
  return circuit === 'NC'
    ? { actuate: 'Block / pull the device (signal drops)', release: 'Clear / reset it (signal returns)' }
    : { actuate: 'Press / actuate the device (signal rises)', release: 'Release it (signal returns)' }
}

// ── device-specific IO-check procedures ─────────────────────────────────────

/**
 * Field device classes recognised for guided IO-check wording. The circuit
 * type (NC/NO) still drives the auto-pass round-trip; this only sharpens the
 * *instruction* the tester reads so generic "actuate/release" becomes a real,
 * field-correct procedure (KK: "we still need to define quite a few of these
 * IO-check procedures").
 */
export type IoDeviceClass =
  | 'photoeye' // PE / TPE / JPE / FPE — block then clear
  | 'pull_cord' // EPC pull cord — pull then reset
  | 'estop' // generic e-stop button — press then reset/release
  | 'pushbutton' // PB / JR jam-reset — press then release
  | 'interlock' // OEM interlock / door / gate switch — open then close
  | 'generic'

/**
 * Classify the physical device class from the tag name + description. This is
 * orthogonal to the NC/NO circuit type — it picks the right *words* for the
 * tester. Order matters: more specific tokens first.
 */
export function classifyIoDeviceClass(
  name?: string | null,
  description?: string | null,
): IoDeviceClass {
  const txt = `${name ?? ''} ${description ?? ''}`
  // Photoeyes: PE / TPE / JPE / FPE tokens or the words PHOTO EYE / PHOTOEYE.
  if (/(^|[_:.\s])(J|T|F)?PE\d/i.test(txt) || /PHOTO\s*-?\s*EYE/i.test(txt)) return 'photoeye'
  // Pull cords: EPC tokens or the words PULL CORD.
  if (/(^|[_:.\s])EPC\d?/i.test(txt) || /PULL\s*-?\s*CORD/i.test(txt)) return 'pull_cord'
  // OEM interlock / door / gate switch — before the generic E-STOP catch so
  // an "interlock" wins over a bare "stop" in the same string.
  if (/INTERLOCK|\bDOOR\b|\bGATE\b/i.test(txt)) return 'interlock'
  // Generic e-stop button (mushroom), distinct from a pull cord.
  if (/E\s*-?\s*STOP/i.test(txt) || /(^|[_:.\s])ES\d/i.test(txt)) return 'estop'
  // Jam-reset / pushbuttons.
  if (/(^|[_:.\s])JR\d/i.test(txt) || /JAM\s*RESET/i.test(txt)) return 'pushbutton'
  if (/(^|[_:.\s])PB\d/i.test(txt) || /PUSH\s*-?\s*BUTTON|PUSHBUTTON/i.test(txt)) return 'pushbutton'
  return 'generic'
}

/**
 * The field-correct, device-specific actuate/release procedure for an IO
 * check. `cls` picks the verbs; `circuit` is the fallback wording for generic
 * devices. The two transitions returned map 1:1 onto the D6 round-trip
 * (actuate = first transition away from idle, release = return to idle).
 */
export function deviceProcedure(
  cls: IoDeviceClass,
  circuit: Circuit,
): { actuate: string; release: string; full: string } {
  switch (cls) {
    case 'photoeye':
      return {
        actuate: 'Block the photoeye',
        release: 'then clear it',
        full: 'Block the photoeye, then clear it',
      }
    case 'pull_cord':
      return {
        actuate: 'Pull the cord',
        release: 'then reset it',
        full: 'Pull the cord, then reset it',
      }
    case 'estop':
      return {
        actuate: 'Press the e-stop',
        release: 'then twist/pull to release and reset it',
        full: 'Press the e-stop, then twist/pull to release and reset it',
      }
    case 'pushbutton':
      return {
        actuate: 'Press the button',
        release: 'then release it',
        full: 'Press the button, then release it',
      }
    case 'interlock':
      return {
        actuate: 'Open the door / interlock',
        release: 'then close it',
        full: 'Open the door / interlock, then close it',
      }
    default:
      // Fall back to the circuit-typed generic wording.
      return circuit === 'NC'
        ? {
            actuate: 'Block / pull it',
            release: 'then clear / reset it',
            full: 'Block / pull it, then clear / reset it',
          }
        : {
            actuate: 'Press / actuate it',
            release: 'then release it',
            full: 'Press / actuate it, then release it',
          }
  }
}
