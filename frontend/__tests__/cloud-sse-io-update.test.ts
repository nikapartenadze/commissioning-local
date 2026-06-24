import { describe, it, expect } from 'vitest'
import { computeSseIoUpdate } from '@/lib/cloud/cloud-sse-client'

// Pair each "Col = ?" clause with its positional param so we can assert by column.
function asMap(out: { clauses: string[]; params: any[] }): Record<string, any> {
  const m: Record<string, any> = {}
  out.clauses.forEach((c, i) => { m[c.replace(' = ?', '').replace(/"/g, '')] = out.params[i] })
  return m
}

describe('computeSseIoUpdate — cloud→field SSE merge (resolver status)', () => {
  it('applies an admin Addressed change LIVE even when the version did not advance', () => {
    // The punchlist PATCH does not bump version, so cloudVersion === localVersion.
    const out = computeSseIoUpdate(
      { id: 1, version: 5, result: 'Failed', timestamp: 't', comments: 'c', punchlistStatus: 'ADDRESSED', clarificationNote: null },
      { Result: 'Failed', Version: 5 },
    )
    const m = asMap(out)
    expect(m.PunchlistStatus).toBe('ADDRESSED')
    expect('ClarificationNote' in m).toBe(true)
    expect(m.ClarificationNote).toBeNull()
    // result/comments must NOT be touched — local owns the result, version not newer.
    expect('Result' in m).toBe(false)
    expect('Comments' in m).toBe(false)
  })

  it('applies Clarification Added with the combined question+answer note', () => {
    const note = 'Why is X wired this way?\n\n— Clarification added: land it on terminal Y'
    const out = computeSseIoUpdate(
      { id: 1, version: 5, punchlistStatus: 'CLARIFICATION_ADDED', clarificationNote: note },
      { Result: 'Failed', Version: 5 },
    )
    const m = asMap(out)
    expect(m.PunchlistStatus).toBe('CLARIFICATION_ADDED')
    expect(m.ClarificationNote).toBe(note)
  })

  it('clears the resolver state when the cloud sends null (e.g. resolved)', () => {
    const out = computeSseIoUpdate(
      { id: 1, version: 5, punchlistStatus: null },
      { Result: 'Passed', Version: 5 },
    )
    const m = asMap(out)
    expect('PunchlistStatus' in m).toBe(true)
    expect(m.PunchlistStatus).toBeNull()
  })

  it('still applies a result when the cloud version is newer (unchanged LWW)', () => {
    const out = computeSseIoUpdate(
      { id: 1, version: 6, result: 'Passed', timestamp: 't', comments: 'c' },
      { Result: 'Failed', Version: 5 },
    )
    expect(asMap(out).Result).toBe('Passed')
  })

  it('does NOT apply a result when the version is not newer and local already has one', () => {
    const out = computeSseIoUpdate(
      { id: 1, version: 5, result: 'Passed', timestamp: 't', comments: 'c' },
      { Result: 'Failed', Version: 5 },
    )
    expect('Result' in asMap(out)).toBe(false)
  })

  it('writes nothing when the event carries no applicable fields', () => {
    const out = computeSseIoUpdate({ id: 1 }, { Result: 'Passed', Version: 5 })
    expect(out.clauses).toHaveLength(0)
  })
})
