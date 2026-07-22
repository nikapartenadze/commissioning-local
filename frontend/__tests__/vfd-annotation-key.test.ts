/**
 * VFD annotation key — subsystem-scoped so a blocker on one MCM's belt can't
 * paint or hide another MCM's same-named belt.
 */
import { describe, it, expect } from 'vitest'
import { vfdAnnotationKey } from '@/lib/vfd-annotation-key'

describe('vfdAnnotationKey', () => {
  it('same device name on DIFFERENT MCMs yields DIFFERENT keys (no cross-MCM leakage)', () => {
    expect(vfdAnnotationKey(40, 'MCM04', 'BYCB_1_VFD')).not.toBe(
      vfdAnnotationKey(47, 'MCM11', 'BYCB_1_VFD'),
    )
  })

  it('same subsystem + name yields the SAME key (map build == lookup)', () => {
    expect(vfdAnnotationKey(51, 'MCM15', 'BYBA_7_VFD')).toBe(
      vfdAnnotationKey(51, 'MCM15', 'BYBA_7_VFD'),
    )
  })

  it('DISTINGUISHES two subsystems sharing one Mcm label (multi-project box)', () => {
    // CDW5 carries MCM02 twice — subsystem 38 from project 15 and 79 from
    // project 18 — with identical belt names. An Mcm-label key collides here;
    // that is why the scope is SubsystemId.
    expect(vfdAnnotationKey(38, 'MCM02', 'UL26_9B_VFD')).not.toBe(
      vfdAnnotationKey(79, 'MCM02', 'UL26_9B_VFD'),
    )
  })

  it('trims whitespace so source/lookup agree', () => {
    expect(vfdAnnotationKey(51, 'MCM15', ' BYBA_7_VFD ')).toBe(
      vfdAnnotationKey(51, 'MCM15', 'BYBA_7_VFD'),
    )
    expect(vfdAnnotationKey(null, ' MCM15 ', 'BYBA_7_VFD')).toBe(
      vfdAnnotationKey(null, 'MCM15', 'BYBA_7_VFD'),
    )
  })

  it('falls back to the Mcm label when SubsystemId is absent (legacy rows)', () => {
    expect(vfdAnnotationKey(null, 'MCM04', 'X_VFD')).toBe('MCM04::X_VFD')
    expect(vfdAnnotationKey(undefined, 'MCM04', 'X_VFD')).toBe('MCM04::X_VFD')
    // 0 is "unattributed", not a real subsystem — must not key as "0".
    expect(vfdAnnotationKey(0, 'MCM04', 'X_VFD')).toBe('MCM04::X_VFD')
  })

  it('tolerates a fully unidentified device without throwing', () => {
    expect(vfdAnnotationKey(null, null, 'X_VFD')).toBe('::X_VFD')
    expect(vfdAnnotationKey(undefined, undefined, 'X_VFD')).toBe('::X_VFD')
  })

  it('a map built by this key keeps two same-named cross-MCM devices distinct', () => {
    const m = new Map<string, string>()
    m.set(vfdAnnotationKey(40, 'MCM04', 'BYCB_1_VFD'), 'mcm04-not-blocked')
    m.set(vfdAnnotationKey(47, 'MCM11', 'BYCB_1_VFD'), 'mcm11-blocked')
    expect(m.get(vfdAnnotationKey(40, 'MCM04', 'BYCB_1_VFD'))).toBe('mcm04-not-blocked')
    expect(m.get(vfdAnnotationKey(47, 'MCM11', 'BYCB_1_VFD'))).toBe('mcm11-blocked')
    expect(m.size).toBe(2)
  })
})
