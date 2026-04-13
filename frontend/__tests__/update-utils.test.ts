import { describe, expect, it } from 'vitest'
import { compareVersions } from '@/lib/update/update-utils'

describe('update version comparison', () => {
  it('detects newer semantic versions', () => {
    expect(compareVersions('2.10.1', '2.10.0')).toBe(1)
    expect(compareVersions('2.11.0', '2.10.9')).toBe(1)
  })

  it('detects older semantic versions', () => {
    expect(compareVersions('2.10.0', '2.10.1')).toBe(-1)
    expect(compareVersions('2.9.9', '2.10.0')).toBe(-1)
  })

  it('treats equivalent versions as equal', () => {
    expect(compareVersions('v2.10.0', '2.10.0')).toBe(0)
    expect(compareVersions('2.10', '2.10.0')).toBe(0)
  })
})
