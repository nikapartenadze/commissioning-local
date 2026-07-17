/**
 * B7 reconcile op-kind supersede guard.
 *
 * Regression for the data-loss finding: the B7 reconcile deleted a stuck RESULT
 * row whenever ANY newer active pending row existed for the same IO — including
 * a comment-only newer row. A comment op does not carry the test result to the
 * cloud, so deleting the result row as "superseded" silently lost the result.
 * A row is only superseded by a newer row of the SAME op kind.
 */
import { describe, it, expect } from 'vitest'
import { isCommentOp, isSupersededBySameKind } from '@/lib/cloud/b7-supersede'

describe('isCommentOp', () => {
  it('classifies comment ops vs result ops', () => {
    for (const c of ['Comment Added', 'Comment Modified', 'Comment Removed', 'Comment Updated', 'comment modified'])
      expect(isCommentOp(c)).toBe(true)
    for (const r of ['Passed', 'Failed', 'Cleared', '', null, undefined])
      expect(isCommentOp(r)).toBe(false)
  })
})

describe('isSupersededBySameKind', () => {
  it('a RESULT stuck row IS superseded by a newer RESULT row', () => {
    expect(isSupersededBySameKind('Passed', ['Failed'])).toBe(true)
    expect(isSupersededBySameKind('Cleared', ['Passed'])).toBe(true)
  })

  it('THE FIX: a RESULT stuck row is NOT superseded by only a comment-only newer row', () => {
    // Deleting it here would lose the test result (the comment op never carries it).
    expect(isSupersededBySameKind('Passed', ['Comment Modified'])).toBe(false)
    expect(isSupersededBySameKind('Failed', ['Comment Added', 'Comment Removed'])).toBe(false)
  })

  it('a RESULT stuck row IS superseded when a newer RESULT row is present among comments', () => {
    expect(isSupersededBySameKind('Passed', ['Comment Modified', 'Failed'])).toBe(true)
  })

  it('a COMMENT stuck row IS superseded by a newer comment row, NOT by a result-only row', () => {
    expect(isSupersededBySameKind('Comment Added', ['Comment Modified'])).toBe(true)
    expect(isSupersededBySameKind('Comment Added', ['Passed'])).toBe(false)
  })

  it('no newer rows → never superseded', () => {
    expect(isSupersededBySameKind('Passed', [])).toBe(false)
    expect(isSupersededBySameKind('Comment Added', [])).toBe(false)
  })
})
