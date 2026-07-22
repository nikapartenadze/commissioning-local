import { describe, it, expect } from 'vitest'
import { computeSseIoUpdate, computeSseL2CellApply } from '@/lib/cloud/cloud-sse-client'

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

describe('computeSseIoUpdate — clear-protection (R3, MCM04 reset loop via SSE)', () => {
  it('does NOT overwrite the result when protected, even with a newer cloud version', () => {
    // Local was cleared (Result null); cloud still holds a higher-versioned
    // Passed. Without protection this would revert the clear over SSE.
    const out = computeSseIoUpdate(
      { id: 1, version: 9, result: 'Passed', timestamp: 't', comments: 'c' },
      { Result: null, Version: 5 },
      true,
    )
    const m = asMap(out)
    expect('Result' in m).toBe(false)
    expect('Timestamp' in m).toBe(false)
    expect('Comments' in m).toBe(false)
    // Definition (version) still applies so metadata stays fresh (matches
    // delta-sync's upsertKeepClearStmt).
    expect(m.Version).toBe(9)
  })

  it('still applies resolver + definition columns while protecting the result', () => {
    const out = computeSseIoUpdate(
      { id: 1, version: 9, result: 'Passed', name: 'IO_A', punchlistStatus: 'ADDRESSED' },
      { Result: null, Version: 5 },
      true,
    )
    const m = asMap(out)
    expect('Result' in m).toBe(false)
    expect(m.Name).toBe('IO_A')
    expect(m.PunchlistStatus).toBe('ADDRESSED')
  })

  it('applies the result normally when NOT protected (unchanged behaviour)', () => {
    const out = computeSseIoUpdate(
      { id: 1, version: 9, result: 'Passed', timestamp: 't', comments: 'c' },
      { Result: null, Version: 5 },
      false,
    )
    expect(asMap(out).Result).toBe('Passed')
  })
})

// ── Live cloud→field L2 cell merge (belt untrack, 2026-07-22) ───────────────
describe('computeSseL2CellApply — cloud→field L2 cell merge', () => {
  const FIELD = 'Check'
  const OWNED = 'Belt Tracked'

  it('CLEARS a filled local "Belt Tracked" cell when the cloud sends empty (untrack syncs DOWN)', () => {
    expect(computeSseL2CellApply('', 'Yes', OWNED, false)).toBe('update')
    expect(computeSseL2CellApply(null, 'Yes', OWNED, false)).toBe('update')
  })

  it('matches the cloud-owned column name case-insensitively', () => {
    expect(computeSseL2CellApply('', 'Yes', 'belt tracked', false)).toBe('update')
    expect(computeSseL2CellApply('', 'Yes', '  BELT TRACKED  ', false)).toBe('update')
  })

  it('does NOT clear a filled cell on a FIELD-owned column (regression guard)', () => {
    expect(computeSseL2CellApply('', 'PASS', FIELD, false)).toBe('skip')
    expect(computeSseL2CellApply(null, 'PASS', FIELD, false)).toBe('skip')
    expect(computeSseL2CellApply('', 'PASS', null, false)).toBe('skip')
    expect(computeSseL2CellApply('', 'PASS', undefined, false)).toBe('skip')
  })

  it('never overwrites a filled FIELD-owned cell with a different cloud value', () => {
    expect(computeSseL2CellApply('FAIL', 'PASS', FIELD, false)).toBe('skip')
  })

  it('still fills an EMPTY local cell from cloud (the belt-tracking handoff)', () => {
    expect(computeSseL2CellApply('Yes', '', OWNED, false)).toBe('update')
    expect(computeSseL2CellApply('PASS', '', FIELD, false)).toBe('update')
    expect(computeSseL2CellApply('PASS', null, FIELD, false)).toBe('update')
  })

  it('inserts when the cell is missing locally', () => {
    expect(computeSseL2CellApply('Yes', null, OWNED, true)).toBe('insert')
  })

  it('writes nothing but STILL broadcasts a value-identical cloud-owned event (open UI repaints)', () => {
    expect(computeSseL2CellApply('', '', OWNED, false)).toBe('broadcast-only')
    expect(computeSseL2CellApply('Yes', 'Yes', OWNED, false)).toBe('broadcast-only')
  })

  it('empty→empty on a field-owned column stays a skip (unchanged)', () => {
    expect(computeSseL2CellApply('', '', FIELD, false)).toBe('skip')
  })
})
