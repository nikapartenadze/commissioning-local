import { describe, it, expect } from 'vitest'

function isTpeFamily(tagType: string | undefined): boolean {
  if (!tagType) return false
  return tagType === 'TPE' || tagType.startsWith('TPE ')
}

function mergeFamilyModes(tagType: string | undefined, dbModes: string[]): string[] {
  if (!isTpeFamily(tagType)) return dbModes
  if (dbModes.includes('Needs alignment')) return dbModes
  return [...dbModes, 'Needs alignment']
}

describe('TPE family failure-mode merge', () => {
  it('appends Needs alignment for TPE Dark Operated when missing', () => {
    expect(mergeFamilyModes('TPE Dark Operated', ['No response', 'Stuck ON', 'Other'])).toEqual([
      'No response',
      'Stuck ON',
      'Other',
      'Needs alignment',
    ])
  })

  it('appends Needs alignment for an unseeded TPE variant', () => {
    expect(mergeFamilyModes('TPE Light Operated', [])).toEqual(['Needs alignment'])
  })

  it('does not duplicate when the DB already returned Needs alignment', () => {
    expect(mergeFamilyModes('TPE Dark Operated', ['Needs alignment', 'Other'])).toEqual([
      'Needs alignment',
      'Other',
    ])
  })

  it('does not apply to non-TPE tag types', () => {
    expect(mergeFamilyModes('Button Press', ['No response'])).toEqual(['No response'])
  })

  it('does not match TPEHardenedOrSimilar (must be exact "TPE" or "TPE " prefix)', () => {
    expect(mergeFamilyModes('TPEHardened', ['No response'])).toEqual(['No response'])
  })

  it('matches bare "TPE"', () => {
    expect(mergeFamilyModes('TPE', [])).toEqual(['Needs alignment'])
  })
})
