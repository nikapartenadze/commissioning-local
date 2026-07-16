import { describe, it, expect } from 'vitest'
import { isMissingColumnDrop } from '@/lib/vfd-bump-blocker'

/**
 * A legacy template that doesn't have a synthetic column (e.g. "Run Verified")
 * makes /write-l2-cells return HTTP 422 with the cell in `dropped`. That is
 * benign — the wizard must skip quietly, NOT fire a destructive "NOT saved —
 * redo this step" toast. A genuine failure (500 / network / mixed) must still
 * surface loud.
 */
describe('isMissingColumnDrop', () => {
  it('BENIGN: 422 where every failure is column-not-found → true (skip quietly)', () => {
    const body = {
      success: false,
      written: [{ columnName: 'Run Verified', ok: false, error: 'Column not found in sheet "APF"' }],
      dropped: [{ columnName: 'Run Verified', ok: false, error: 'Column not found in sheet "APF"' }],
    }
    expect(isMissingColumnDrop(422, body)).toBe(true)
  })

  it('mixed 422: a real error alongside a missing column → false (surface loud)', () => {
    const body = {
      written: [
        { columnName: 'Run Verified', ok: false, error: 'Column not found in sheet "APF"' },
        { columnName: 'Polarity', ok: false, error: 'db write failed' },
      ],
      dropped: [{ columnName: 'Run Verified', ok: false, error: 'Column not found in sheet "APF"' }],
    }
    expect(isMissingColumnDrop(422, body)).toBe(false)
  })

  it('non-422 statuses are never benign (genuine failures)', () => {
    expect(isMissingColumnDrop(500, { written: [], dropped: [] })).toBe(false)
    expect(isMissingColumnDrop(200, { written: [{ ok: true }], dropped: [] })).toBe(false)
  })

  it('422 with no dropped cells is not this case', () => {
    expect(isMissingColumnDrop(422, { written: [], dropped: [] })).toBe(false)
    expect(isMissingColumnDrop(422, null)).toBe(false)
  })
})
