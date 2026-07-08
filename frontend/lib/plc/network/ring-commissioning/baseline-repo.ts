/**
 * Local persistence for approved ring baselines. Takes the better-sqlite3
 * connection as a parameter (no import-time singleton) so it is testable with a
 * temp DB. The topology is stored as a JSON blob — tiny surface, matches the
 * "not core, low-risk" ethos.
 */
import type { Database } from 'better-sqlite3'
import type { RingBaseline, RingTopology } from './types'

interface Row {
  SubsystemId: number; RingName: string; CapturedAt: string
  ApprovedBy: string | null; ApprovedAt: string | null; TopologyJson: string
}

function toBaseline(r: Row): RingBaseline {
  return {
    subsystemId: r.SubsystemId, ringName: r.RingName, capturedAt: r.CapturedAt,
    approvedBy: r.ApprovedBy, approvedAt: r.ApprovedAt,
    topology: JSON.parse(r.TopologyJson) as RingTopology,
  }
}

/** Insert or replace the approved baseline for (subsystemId, ringName). */
export function saveBaseline(db: Database, b: RingBaseline): void {
  db.prepare(`
    INSERT INTO RingBaselines (SubsystemId, RingName, CapturedAt, ApprovedBy, ApprovedAt, TopologyJson)
    VALUES (@SubsystemId, @RingName, @CapturedAt, @ApprovedBy, @ApprovedAt, @TopologyJson)
    ON CONFLICT(SubsystemId, RingName) DO UPDATE SET
      CapturedAt=excluded.CapturedAt, ApprovedBy=excluded.ApprovedBy,
      ApprovedAt=excluded.ApprovedAt, TopologyJson=excluded.TopologyJson
  `).run({
    SubsystemId: b.subsystemId, RingName: b.ringName, CapturedAt: b.capturedAt,
    ApprovedBy: b.approvedBy, ApprovedAt: b.approvedAt, TopologyJson: JSON.stringify(b.topology),
  })
}

export function getBaseline(db: Database, subsystemId: number, ringName: string): RingBaseline | null {
  const r = db.prepare('SELECT * FROM RingBaselines WHERE SubsystemId=? AND RingName=?').get(subsystemId, ringName) as Row | undefined
  return r ? toBaseline(r) : null
}

export function listBaselines(db: Database, subsystemId: number): RingBaseline[] {
  const rows = db.prepare('SELECT * FROM RingBaselines WHERE SubsystemId=? ORDER BY RingName').all(subsystemId) as Row[]
  return rows.map(toBaseline)
}
