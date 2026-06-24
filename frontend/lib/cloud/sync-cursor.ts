import { db } from '@/lib/db-sqlite'

/**
 * Per-subsystem delta-sync cursor repository (SyncCursors table).
 *
 * The cursor is the highest cloud change-log `seq` this tool has applied for a
 * subsystem. It is the source of truth for catch-up: the delta endpoint returns
 * everything newer, so a missed SSE hint or a cloud restart is harmless — the
 * tool reconciles from its cursor on the next sync.
 */

/** Highest applied seq for the subsystem; 0 when never synced (→ bootstrap). */
export function getSyncCursor(subsystemId: number): number {
  const row = db
    .prepare('SELECT LastSeq FROM SyncCursors WHERE SubsystemId = ?')
    .get(subsystemId) as { LastSeq: number } | undefined
  return row?.LastSeq ?? 0
}

/**
 * Advance the cursor. Forward-only: a lower seq is ignored so an out-of-order
 * or stale apply can never rewind catch-up and cause repeated re-fetching.
 */
export function setSyncCursor(subsystemId: number, seq: number): void {
  db.prepare(
    `INSERT INTO SyncCursors (SubsystemId, LastSeq, UpdatedAt)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(SubsystemId) DO UPDATE SET
       LastSeq = excluded.LastSeq,
       UpdatedAt = datetime('now')
     WHERE excluded.LastSeq > SyncCursors.LastSeq`,
  ).run(subsystemId, seq)
}
