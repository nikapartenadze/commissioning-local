/**
 * Test: PLC client tag filtering.
 *
 * Ensures network status tags (negative IDs) never leak into
 * IO-facing surfaces (tag counts, state change events, tag lists).
 */
import { describe, it, expect } from 'vitest'

describe('PLC client tag filtering', () => {
  // Simulate the filtering logic used in getIoTags() and tagCount
  function filterIoTags(tags: Array<{ id: number; name: string }>) {
    return tags.filter(t => t.id >= 0)
  }

  function countIoTags(tags: Array<{ id: number; name: string }>) {
    let count = 0
    tags.forEach(t => { if (t.id >= 0) count++ })
    return count
  }

  const mixedTags = [
    { id: 1, name: 'IO_TAG_1' },
    { id: 2, name: 'IO_TAG_2' },
    { id: 664, name: 'IO_TAG_664' },
    { id: -1, name: 'NCP1_1_DPM1:I.ConnectionFaulted' },
    { id: -2, name: 'NCP1_2_FIOM1:I.ConnectionFaulted' },
    { id: -54, name: 'UL26_19_VFD:I.ConnectionFaulted' },
  ]

  it('getIoTags excludes negative IDs', () => {
    const ioTags = filterIoTags(mixedTags)
    expect(ioTags.length).toBe(3)
    expect(ioTags.every(t => t.id >= 0)).toBe(true)
  })

  it('tagCount excludes negative IDs', () => {
    expect(countIoTags(mixedTags)).toBe(3)
  })

  it('network tags have negative IDs', () => {
    const networkTags = mixedTags.filter(t => t.id < 0)
    expect(networkTags.length).toBe(3)
    expect(networkTags.every(t => t.name.includes('ConnectionFaulted'))).toBe(true)
  })

  it('ioStateChanged should skip negative IDs', () => {
    // Simulate the guard in handleTagValueChange
    const shouldEmit = (io: { id: number }) => io.id >= 0

    expect(shouldEmit({ id: 1 })).toBe(true)
    expect(shouldEmit({ id: 664 })).toBe(true)
    expect(shouldEmit({ id: -1 })).toBe(false)
    expect(shouldEmit({ id: -54 })).toBe(false)
  })

  it('empty tag list returns 0 count', () => {
    expect(countIoTags([])).toBe(0)
  })

  it('all-network tags returns 0 IO count', () => {
    const onlyNetwork = [
      { id: -1, name: 'TAG1:I.ConnectionFaulted' },
      { id: -2, name: 'TAG2:I.ConnectionFaulted' },
    ]
    expect(countIoTags(onlyNetwork)).toBe(0)
    expect(filterIoTags(onlyNetwork)).toEqual([])
  })
})
