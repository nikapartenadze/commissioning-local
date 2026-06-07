import { describe, it, expect } from 'vitest'
import {
  VFD_BLOCKER_PARTIES,
  VFD_BLOCKER_VOCAB,
  buildVfdBlockerDescription,
  type VfdBlockerParty,
} from '@/lib/blockers'

describe('VFD_BLOCKER_PARTIES', () => {
  it('is exactly the three agreed parties (no 3rd Party)', () => {
    expect(VFD_BLOCKER_PARTIES).toEqual(['Controls', 'Electrical', 'Mechanical'])
  })
})

describe('VFD_BLOCKER_VOCAB', () => {
  // Guards against typos drifting from Kevin's memo (taskboard #2170).
  it('matches the spec lists exactly', () => {
    expect(VFD_BLOCKER_VOCAB).toEqual({
      Controls: ['VFD did not turn on', 'Other'],
      Electrical: [
        'VFD Faults Immediately',
        'VFD Faults after Running',
        "VFD turns on, motor doesn't move, motor fan doesn't move",
        'Other',
      ],
      Mechanical: [
        'VFD turns on, drive shaft moves, belt is slipping',
        "VFD turns on, drive shaft doesn't move",
        'VFD turns on, belt moves, makes harsh noise',
        'Other',
      ],
    })
  })

  it('every party ends with Other', () => {
    for (const party of VFD_BLOCKER_PARTIES) {
      const list = VFD_BLOCKER_VOCAB[party]
      expect(list[list.length - 1]).toBe('Other')
    }
  })
})

describe('buildVfdBlockerDescription', () => {
  it('returns a non-Other description verbatim (comment ignored)', () => {
    expect(buildVfdBlockerDescription('VFD did not turn on')).toBe('VFD did not turn on')
    expect(
      buildVfdBlockerDescription('VFD Faults Immediately', 'ignored comment'),
    ).toBe('VFD Faults Immediately')
  })

  it("folds Other + comment into 'Other: <trimmed comment>'", () => {
    expect(buildVfdBlockerDescription('Other', 'belt keeps jumping off')).toBe(
      'Other: belt keeps jumping off',
    )
    expect(buildVfdBlockerDescription('Other', '   trimmed   ')).toBe('Other: trimmed')
  })

  it('throws on Other with empty / whitespace / missing comment', () => {
    expect(() => buildVfdBlockerDescription('Other')).toThrow()
    expect(() => buildVfdBlockerDescription('Other', '')).toThrow()
    expect(() => buildVfdBlockerDescription('Other', '   ')).toThrow()
  })
})

describe('VfdBlockerParty type', () => {
  it('accepts the literal party names', () => {
    const p: VfdBlockerParty = 'Mechanical'
    expect(VFD_BLOCKER_PARTIES.includes(p)).toBe(true)
  })
})
