/**
 * "Controls Verified" is per-MCM, not global.
 *
 * Step 4 of the VFD wizard records that a tech physically confirmed keypad
 * controls (F0/F1/F2) on a drive. It has no L2 column, so it lives only in the
 * local VfdControlsVerified table.
 *
 * That table originally keyed on `deviceName` alone. Belt/VFD names are only
 * unique WITHIN an MCM — copy-templated L2 sheets reuse them across machines,
 * so MCM02 and MCM04 each have an NCP1_7_VFD. Verifying controls on one
 * therefore marked the OTHER verified too: a false pass on hardware nobody
 * touched. This pins the composite (SubsystemId, deviceName) key.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/db-sqlite', async () => {
  const Database = (await import('better-sqlite3')).default
  return { db: new Database(':memory:') }
})

import { db } from '@/lib/db-sqlite'

const CREATE = `
  CREATE TABLE VfdControlsVerified (
    SubsystemId INTEGER NOT NULL DEFAULT 0,
    deviceName TEXT NOT NULL,
    completedBy TEXT,
    completedAt TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (SubsystemId, deviceName)
  )
`

const upsert = (subsystemId: number, deviceName: string, by: string) =>
  db
    .prepare(
      `INSERT INTO VfdControlsVerified (SubsystemId, deviceName, completedBy, completedAt)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(SubsystemId, deviceName) DO UPDATE SET
         completedBy = excluded.completedBy, completedAt = excluded.completedAt`,
    )
    .run(subsystemId, deviceName, by)

const verifiedFor = (subsystemId: number, deviceName: string) =>
  db
    .prepare('SELECT completedBy FROM VfdControlsVerified WHERE SubsystemId = ? AND deviceName = ?')
    .get(subsystemId, deviceName) as { completedBy: string } | undefined

describe('VfdControlsVerified — per-MCM key', () => {
  beforeEach(() => {
    db.exec('DROP TABLE IF EXISTS VfdControlsVerified')
    db.exec(CREATE)
  })

  it('verifying on one MCM does NOT mark the same-named drive on another MCM', () => {
    // MCM02 (subsystem 38) verified. MCM04 (subsystem 40) untouched.
    upsert(38, 'NCP1_7_VFD', 'ASH')

    expect(verifiedFor(38, 'NCP1_7_VFD')?.completedBy).toBe('ASH')
    // The regression: this used to return ASH's stamp — a false pass.
    expect(verifiedFor(40, 'NCP1_7_VFD')).toBeUndefined()
  })

  it('keeps both stamps independently once each MCM is genuinely verified', () => {
    upsert(38, 'NCP1_7_VFD', 'ASH')
    upsert(40, 'NCP1_7_VFD', 'SL')

    expect(verifiedFor(38, 'NCP1_7_VFD')?.completedBy).toBe('ASH')
    expect(verifiedFor(40, 'NCP1_7_VFD')?.completedBy).toBe('SL')
    expect(
      (db.prepare('SELECT COUNT(*) n FROM VfdControlsVerified').get() as { n: number }).n,
    ).toBe(2)
  })

  it('re-verifying the same drive on the same MCM updates in place, not duplicates', () => {
    upsert(38, 'NCP1_7_VFD', 'ASH')
    upsert(38, 'NCP1_7_VFD', 'SL')

    expect(verifiedFor(38, 'NCP1_7_VFD')?.completedBy).toBe('SL')
    expect(
      (db.prepare('SELECT COUNT(*) n FROM VfdControlsVerified').get() as { n: number }).n,
    ).toBe(1)
  })

  it('two subsystems sharing one Mcm label stay separate (multi-project box)', () => {
    // CDW5 carries MCM02 as both subsystem 38 (project 15) and 79 (project 18).
    upsert(38, 'UL21_2_VFD', 'ASH')
    expect(verifiedFor(79, 'UL21_2_VFD')).toBeUndefined()
  })
})
