/**
 * VFD annotation key — MCM-scoped so a blocker on one MCM's belt can't paint or
 * hide another MCM's same-named belt in the multi-MCM VFD grid.
 */
import { describe, it, expect } from 'vitest'
import { vfdAnnotationKey } from '@/lib/vfd-annotation-key'

describe('vfdAnnotationKey', () => {
  it('same device name on DIFFERENT MCMs yields DIFFERENT keys (no cross-MCM leakage)', () => {
    expect(vfdAnnotationKey('MCM04', 'BYCB_1_VFD')).not.toBe(vfdAnnotationKey('MCM11', 'BYCB_1_VFD'))
  })

  it('same MCM + name yields the SAME key (map build == lookup)', () => {
    expect(vfdAnnotationKey('MCM15', 'BYBA_7_VFD')).toBe(vfdAnnotationKey('MCM15', 'BYBA_7_VFD'))
  })

  it('trims whitespace on both parts so source/lookup agree', () => {
    expect(vfdAnnotationKey(' MCM15 ', ' BYBA_7_VFD ')).toBe(vfdAnnotationKey('MCM15', 'BYBA_7_VFD'))
  })

  it('tolerates null/blank MCM (single-MCM/legacy rows) without throwing', () => {
    expect(vfdAnnotationKey(null, 'X_VFD')).toBe('::X_VFD')
    expect(vfdAnnotationKey(undefined, 'X_VFD')).toBe('::X_VFD')
    expect(vfdAnnotationKey('', 'X_VFD')).toBe('::X_VFD')
  })

  it('a map built by this key keeps two same-named cross-MCM devices distinct', () => {
    const m = new Map<string, string>()
    m.set(vfdAnnotationKey('MCM04', 'BYCB_1_VFD'), 'mcm04-not-blocked')
    m.set(vfdAnnotationKey('MCM11', 'BYCB_1_VFD'), 'mcm11-blocked')
    expect(m.get(vfdAnnotationKey('MCM04', 'BYCB_1_VFD'))).toBe('mcm04-not-blocked')
    expect(m.get(vfdAnnotationKey('MCM11', 'BYCB_1_VFD'))).toBe('mcm11-blocked')
    expect(m.size).toBe(2)
  })
})
