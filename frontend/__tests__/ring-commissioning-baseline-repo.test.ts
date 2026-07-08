import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { saveBaseline, getBaseline, listBaselines } from '@/lib/plc/network/ring-commissioning/baseline-repo'
import type { RingBaseline } from '@/lib/plc/network/ring-commissioning/types'

function tempDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE RingBaselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, SubsystemId INTEGER NOT NULL, RingName TEXT NOT NULL,
    CapturedAt TEXT NOT NULL, ApprovedBy TEXT, ApprovedAt TEXT, TopologyJson TEXT NOT NULL,
    CreatedAt TEXT DEFAULT (datetime('now')), UNIQUE(SubsystemId, RingName))`)
  return db
}
function sample(): RingBaseline {
  return {
    subsystemId: 40, ringName: 'CDW5 Ring', capturedAt: '2026-07-08T00:00:00Z',
    approvedBy: 'ilia', approvedAt: '2026-07-08T00:05:00Z',
    topology: { links: [], leaves: [], terminations: [], ring: { closed: true, source: 'dlr', reason: 'ok' } },
  }
}

describe('baseline-repo', () => {
  it('saves and reads back a baseline', () => {
    const db = tempDb()
    saveBaseline(db, sample())
    const got = getBaseline(db, 40, 'CDW5 Ring')
    expect(got?.approvedBy).toBe('ilia')
    expect(got?.topology.ring.closed).toBe(true)
  })
  it('re-saving the same ring replaces (upsert)', () => {
    const db = tempDb()
    saveBaseline(db, sample())
    saveBaseline(db, { ...sample(), approvedBy: 'nika' })
    expect(getBaseline(db, 40, 'CDW5 Ring')?.approvedBy).toBe('nika')
    expect(listBaselines(db, 40).length).toBe(1)
  })
  it('getBaseline returns null when absent', () => {
    expect(getBaseline(tempDb(), 1, 'none')).toBeNull()
  })
})
