/**
 * Persistence for ring commissioning: the saved baseline (expected wiring) and
 * the check-run history. Uses the runtime better-sqlite3 layer directly, like
 * the rest of the network routes.
 */

import { db } from '@/lib/db-sqlite';
import type { RingBaseline, RingCheckReport } from './types';

interface BaselineRow {
  RingId: number;
  Links: string;
  ChassisMap: string;
  SavedBy: string | null;
  SavedAt: string;
}

/** Load the saved baseline for a ring, or null if none has been saved yet. */
export function getBaseline(ringId: number): RingBaseline | null {
  const row = db
    .prepare('SELECT * FROM NetworkRingBaselines WHERE RingId = ?')
    .get(ringId) as BaselineRow | undefined;
  if (!row) return null;
  return {
    ringId,
    links: safeParse(row.Links, []),
    chassisToDpm: safeParse(row.ChassisMap, {}),
    savedBy: row.SavedBy ?? undefined,
    savedAt: Date.parse(row.SavedAt) || Date.now(),
  };
}

/** Insert or replace the baseline for a ring. */
export function saveBaseline(baseline: RingBaseline): void {
  db.prepare(
    `INSERT INTO NetworkRingBaselines (RingId, Links, ChassisMap, SavedBy, SavedAt)
     VALUES (@RingId, @Links, @ChassisMap, @SavedBy, datetime('now'))
     ON CONFLICT(RingId) DO UPDATE SET
       Links = excluded.Links,
       ChassisMap = excluded.ChassisMap,
       SavedBy = excluded.SavedBy,
       SavedAt = excluded.SavedAt`,
  ).run({
    RingId: baseline.ringId,
    Links: JSON.stringify(baseline.links),
    ChassisMap: JSON.stringify(baseline.chassisToDpm),
    SavedBy: baseline.savedBy ?? null,
  });
}

/** Delete a ring's baseline (e.g. before re-learning after a legitimate rewire). */
export function deleteBaseline(ringId: number): void {
  db.prepare('DELETE FROM NetworkRingBaselines WHERE RingId = ?').run(ringId);
}

/** Append a check run to the audit history. */
export function recordCheckRun(report: RingCheckReport, runBy?: string): void {
  db.prepare(
    `INSERT INTO NetworkRingCheckRuns (RingId, Overall, Report, RunBy)
     VALUES (?, ?, ?, ?)`,
  ).run(report.ringId, report.overall, JSON.stringify(report), runBy ?? null);
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
