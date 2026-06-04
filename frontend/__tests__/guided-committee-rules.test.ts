import { describe, expect, it } from 'vitest'
import {
  advanceRoundTrip,
  classifyIoCircuit,
  expectedIdleState,
  precheckFailure,
  startRoundTrip,
  type RoundTrip,
} from '@/lib/guided/io-check-sequence'
import { deriveSystemRunning, isRunIndicatorTag } from '@/lib/guided/system-running'
import {
  associatedIosFor,
  locationPrefixOf,
  pendingAssociatedLabels,
} from '@/lib/guided/task-pool/associations'
import { SKIP_REASONS, composeSkipReason } from '@/lib/guided/task-pool/skip-reasons'
import type { SnapshotDevice, SnapshotIo } from '@/lib/guided/task-pool/snapshot-types'

/**
 * Pure-rule tests for the 2026-06 Guided Mode committee decisions:
 * D3 association mapping, D4 system-running derivation, D6 NC/NO circuit
 * classification + round-trip sequencing + pre-check, D9 skip reasons.
 */

// ── D6: circuit classification ──────────────────────────────────────────────

describe('classifyIoCircuit', () => {
  it('classifies photoeyes (PE/TPE/JPE/FPE) as NC', () => {
    expect(classifyIoCircuit('PS8_10_CH4_PE1', null)).toBe('NC')
    expect(classifyIoCircuit('PS8_10_CH4_TPE2', null)).toBe('NC')
    expect(classifyIoCircuit('PS8_10_CH4_JPE1', 'JAM PHOTOEYE')).toBe('NC')
    expect(classifyIoCircuit('X', 'FULL PHOTO EYE')).toBe('NC')
  })

  it('classifies e-stops / EPCs / pull cords as NC', () => {
    expect(classifyIoCircuit('UL17_EPC1', null)).toBe('NC')
    expect(classifyIoCircuit('X', 'E-STOP PULL CORD')).toBe('NC')
    expect(classifyIoCircuit('DEV:SI.In0Data', null)).toBe('NC')
  })

  it('classifies pushbuttons / beacons / generic discretes as NO', () => {
    expect(classifyIoCircuit('PS8_10_CH4_JR1', 'JAM RESET PUSHBUTTON')).toBe('NO')
    expect(classifyIoCircuit('PS8_10_CH4_BCN1', 'GREEN BEACON')).toBe('NO')
    expect(classifyIoCircuit('DEV:I.In_3', null)).toBe('NO')
  })

  it('idle state: NC rests TRUE, NO rests FALSE', () => {
    expect(expectedIdleState('NC')).toBe('TRUE')
    expect(expectedIdleState('NO')).toBe('FALSE')
  })
})

// ── D6: pre-check ───────────────────────────────────────────────────────────

describe('precheckFailure', () => {
  it('fails an NC point reading FALSE at rest', () => {
    expect(precheckFailure('NC', 'FALSE', 'PE1')).toMatch(/PE1 reads FALSE at rest/)
  })
  it('passes NC TRUE, NC unknown, and every NO state', () => {
    expect(precheckFailure('NC', 'TRUE', 'PE1')).toBeNull()
    expect(precheckFailure('NC', null, 'PE1')).toBeNull()
    expect(precheckFailure('NO', 'TRUE', 'PB1')).toBeNull()
    expect(precheckFailure('NO', 'FALSE', 'PB1')).toBeNull()
  })
})

// ── D6: round-trip sequencing ───────────────────────────────────────────────

describe('round-trip state machine', () => {
  const run = (circuit: 'NC' | 'NO' | null, states: ('TRUE' | 'FALSE')[]): RoundTrip =>
    states.reduce((rt, s) => advanceRoundTrip(rt, s), startRoundTrip(circuit))

  it('NC: TRUE → FALSE → TRUE completes', () => {
    expect(run('NC', ['TRUE', 'FALSE', 'TRUE']).phase).toBe('complete')
  })

  it('NO: FALSE → TRUE → FALSE completes', () => {
    expect(run('NO', ['FALSE', 'TRUE', 'FALSE']).phase).toBe('complete')
  })

  it('a single transition does NOT complete (the old any-transition rule)', () => {
    expect(run('NC', ['TRUE', 'FALSE']).phase).toBe('await_return')
    expect(run('NO', ['FALSE', 'TRUE']).phase).toBe('await_return')
  })

  it('repeated idle states stay armed', () => {
    expect(run('NC', ['TRUE', 'TRUE', 'TRUE']).phase).toBe('await_actuate')
  })

  it('a device already actuated when the step arms completes on the return alone', () => {
    // NC photoeye blocked before the tool armed: first seen FALSE (≠ idle).
    expect(run('NC', ['FALSE', 'TRUE']).phase).toBe('complete')
  })

  it('anchors on first-seen state when the circuit is unknown', () => {
    expect(run(null, ['TRUE', 'FALSE', 'TRUE']).phase).toBe('complete')
    expect(run(null, ['FALSE', 'TRUE', 'FALSE']).phase).toBe('complete')
    expect(run(null, ['FALSE', 'TRUE']).phase).toBe('await_return')
  })

  it('stays complete once complete', () => {
    expect(run('NO', ['FALSE', 'TRUE', 'FALSE', 'TRUE']).phase).toBe('complete')
  })
})

// ── D4: system-running derivation ───────────────────────────────────────────

describe('deriveSystemRunning', () => {
  it('recognises run-indicating tags', () => {
    expect(isRunIndicatorTag('UL17_19_VFD:O.Run')).toBe(true)
    expect(isRunIndicatorTag('ZONE1.Run_Up')).toBe(true)
    expect(isRunIndicatorTag('CBT_UL17.CTRL.STS.Running')).toBe(true)
    expect(isRunIndicatorTag('CONV2_RUN')).toBe(true)
  })

  it('rejects look-alike tags (overrides, faults, timers)', () => {
    expect(isRunIndicatorTag('CBT_UL17.CTRL.CMD.Override_RVS')).toBe(false)
    expect(isRunIndicatorTag('UL17_RunFault')).toBe(false)
    expect(isRunIndicatorTag('Jog_Start_TMR.RunTime')).toBe(false)
    expect(isRunIndicatorTag('PE1:I.Blocked')).toBe(false)
  })

  it('any run tag TRUE → running', () => {
    expect(
      deriveSystemRunning([
        { name: 'A:O.Run', state: 'FALSE' },
        { name: 'B:O.Run', state: 'TRUE' },
      ]),
    ).toBe(true)
  })

  it('run tags known, all FALSE → stopped', () => {
    expect(deriveSystemRunning([{ name: 'A:O.Run', state: 'FALSE' }])).toBe(false)
  })

  it('no run tags → unknown (null, never blocks)', () => {
    expect(deriveSystemRunning([{ name: 'PE1:I.Blocked', state: 'TRUE' }])).toBeNull()
    expect(deriveSystemRunning([])).toBeNull()
  })
})

// ── D3: association mapping ─────────────────────────────────────────────────

function snapIo(id: number, name: string, result: SnapshotIo['result'] = null): SnapshotIo {
  return {
    id,
    name,
    description: null,
    result,
    tagType: null,
    isOutput: false,
    isSafety: false,
    circuit: 'NO',
    liveState: null,
  }
}

describe('locationPrefixOf', () => {
  it('derives the prefix from a typed device name', () => {
    expect(locationPrefixOf('PS8_10_CH4_JPE1')).toBe('PS8_10_CH4')
    expect(locationPrefixOf('PS8_10_CH4_SS2')).toBe('PS8_10_CH4')
    expect(locationPrefixOf('UL17_19_ENC1')).toBe('UL17_19')
  })
  it('returns null when no type token exists', () => {
    expect(locationPrefixOf('SS1')).toBeNull()
    expect(locationPrefixOf('UL17_19')).toBeNull()
    expect(locationPrefixOf(null)).toBeNull()
  })
})

describe('associatedIosFor', () => {
  const devices: SnapshotDevice[] = [
    {
      deviceName: 'DPM1',
      order: 0,
      ios: [
        snapIo(1, 'PS8_10_CH4_JPE1'),
        snapIo(2, 'PS8_10_CH4_BCN1', 'Passed'),
        snapIo(3, 'PS8_10_CH40_BCN1'), // boundary trap: CH40 ≠ CH4
        snapIo(4, 'PS9_1_CH1_JR1'),
      ],
      isSafety: false,
      installComplete: null,
      networked: null,
    },
  ]

  it('matches only exact-boundary prefixed IOs', () => {
    const assoc = associatedIosFor('PS8_10_CH4_JPE1', devices)
    expect(assoc.map((a) => a.io.id)).toEqual([1, 2])
  })

  it('lists pending labels for unchecked associated IOs', () => {
    const assoc = associatedIosFor('PS8_10_CH4_JPE1', devices)
    expect(pendingAssociatedLabels(assoc)).toEqual(['JPE1'])
  })

  it('returns empty when no prefix or nothing matches', () => {
    expect(associatedIosFor('SS1', devices)).toEqual([])
    expect(associatedIosFor('ZZ9_9_PE1', devices)).toEqual([])
  })
})

// ── D9: skip reasons ────────────────────────────────────────────────────────

describe('skip reasons (D9)', () => {
  it('offers the committee preset list', () => {
    expect(SKIP_REASONS).toEqual([
      'Not installed',
      'Damaged',
      'Access blocked',
      '3rd-party dependency',
      'Out of scope',
      'Other',
    ])
  })

  it('composes preset + optional note', () => {
    expect(composeSkipReason('Damaged')).toBe('Damaged')
    expect(composeSkipReason('Damaged', ' belt torn ')).toBe('Damaged: belt torn')
  })

  it('Other uses the note as the whole reason (empty when missing)', () => {
    expect(composeSkipReason('Other', 'weird edge case')).toBe('weird edge case')
    expect(composeSkipReason('Other')).toBe('')
  })
})
