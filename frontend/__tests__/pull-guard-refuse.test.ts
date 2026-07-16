/**
 * D5: computePullRiskOrRefuse is the single guard body shared by /api/cloud/pull
 * (legacy global scope) and /api/mcm/[subsystemId]/pull (per-MCM scope). This
 * locks the extraction: identical 409 SHAPE for both, scope-correct queries, the
 * per-scope error text, and the force-override pass-through.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { memDb } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE Ios (id INTEGER PRIMARY KEY, Name TEXT, SubsystemId INTEGER, Result TEXT, Comments TEXT, Timestamp TEXT, CloudRemoved INTEGER DEFAULT 0);
    CREATE TABLE PendingSyncs (IoId INTEGER);
    CREATE TABLE TestHistories (id INTEGER PRIMARY KEY AUTOINCREMENT, IoId INTEGER, Result TEXT, Timestamp TEXT);
  `)
  return { memDb: d }
})

import { computePullRiskOrRefuse } from '@/lib/cloud/pull-guard'

beforeEach(() => {
  memDb.exec('DELETE FROM Ios; DELETE FROM PendingSyncs; DELETE FROM TestHistories;')
  // A local Passed the cloud payload lacks → the MCM08 at-risk shape.
  memDb.prepare('INSERT INTO Ios (id, Name, SubsystemId, Result, Timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'IO_A', 42, 'Passed', '2026-07-01T00:00:00.000Z')
})

const cloudLacksResult = [{ id: 1, result: null }]
const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

describe('computePullRiskOrRefuse', () => {
  it('per-MCM scope refuses with the MCM-labelled message and scoped queries', () => {
    warn()
    const d = computePullRiskOrRefuse({ db: memDb, subsystemId: 42, logPrefix: '[MCM 42 Pull]' }, cloudLacksResult, false)
    expect(d.refuse).not.toBeNull()
    expect(d.refuse!.status).toBe(409)
    const body = d.refuse!.body as Record<string, unknown>
    expect(body.requiresForce).toBe(true)
    expect(body.wouldLoseResults).toBe(1)
    expect(String(body.error)).toContain('MCM 42')
    expect(d.atRisk).toHaveLength(1)
  })

  it('legacy global scope refuses with the generic (no-MCM) message', () => {
    warn()
    const d = computePullRiskOrRefuse({ db: memDb, subsystemId: null, logPrefix: '[CloudPull]' }, cloudLacksResult, false)
    expect(d.refuse).not.toBeNull()
    expect(String((d.refuse!.body as Record<string, unknown>).error)).not.toContain('MCM')
    // Same 409 shape as the scoped route.
    const body = d.refuse!.body as Record<string, unknown>
    for (const k of ['requiresForce', 'wouldLoseResults', 'wouldLoseComments', 'wouldOverwriteNewerLocal', 'wouldRevertClears', 'atRiskSample']) {
      expect(body).toHaveProperty(k)
    }
  })

  it('force=true passes through (no refuse) but still reports the risk arrays', () => {
    warn()
    const d = computePullRiskOrRefuse({ db: memDb, subsystemId: 42, logPrefix: '[MCM 42 Pull]' }, cloudLacksResult, true)
    expect(d.refuse).toBeNull()
    expect(d.atRisk).toHaveLength(1)
  })

  it('scopes to the subsystem — another MCM\'s at-risk row does not trigger a refuse', () => {
    warn()
    // subsystem 99 has no at-risk local rows; row above belongs to 42.
    const d = computePullRiskOrRefuse({ db: memDb, subsystemId: 99, logPrefix: '[MCM 99 Pull]' }, cloudLacksResult, false)
    expect(d.refuse).toBeNull()
    expect(d.atRisk).toHaveLength(0)
  })
})
