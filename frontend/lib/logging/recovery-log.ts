/**
 * Recovery audit log — append-only JSONL record of every state-changing /
 * recoverable event on the central server.
 *
 * Purpose: if local↔cloud sync ever diverges or a push is dropped, this file is
 * the durable, machine-readable record from which data can be reconstructed.
 * It complements (does not replace) the TestHistories table (the in-DB audit
 * trail) and the periodic DB backups.
 *
 * Design rules:
 *  - NEVER throws. Logging failure must not break a test write or a sync.
 *  - One JSONL line per event: `{ ts, type, ...fields }`.
 *  - Daily files: `audit-YYYY-MM-DD.jsonl` in the logs dir → natural rotation.
 *  - Time-based retention: prune files older than RECOVERY_LOG_RETENTION_DAYS
 *    (default 14). Resource use is acceptable per ops requirement.
 *  - Synchronous appendFileSync — these events are low-frequency relative to
 *    tag reads (a human pressing pass/fail), and durability > throughput here.
 */

import fs from 'fs';
import path from 'path';
import { resolveLogsDirPath } from '@/lib/storage-paths';

const RETENTION_DAYS = (() => {
  const n = parseInt(process.env.RECOVERY_LOG_RETENTION_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
})();

const FILE_PREFIX = 'audit-';
const FILE_SUFFIX = '.jsonl';

export type AuditEventType =
  | 'io.test'
  | 'io.reset'
  | 'io.addressed'
  | 'sync.push.ok'
  | 'sync.push.defer'
  | 'sync.push.drop' // a pending push was discarded — the recovery-critical case
  | 'sync.push.park' // a pending push was PARKED (cloud-rejected/cap) — kept for attention, not lost
  | 'sync.pull'
  | 'plc.connect'
  | 'plc.disconnect'
  | 'mcm.import'
  | 'server.start';

export interface AuditEvent {
  type: AuditEventType;
  subsystemId?: string | number | null;
  ioId?: number | null;
  user?: string | null;
  result?: string | null;
  version?: number | null;
  /** For sync.push.drop / defer — why. */
  reason?: string | null;
  /** Any extra structured context (kept small). */
  detail?: Record<string, unknown>;
}

let lastPrunedDay = '';

function dayStamp(d: Date): string {
  // YYYY-MM-DD in UTC for stable, sortable filenames.
  return d.toISOString().slice(0, 10);
}

function currentFile(logDir: string, day: string): string {
  return path.join(logDir, `${FILE_PREFIX}${day}${FILE_SUFFIX}`);
}

/** Prune audit files older than the retention window. Best-effort, once/day. */
function pruneOldFiles(logDir: string, today: Date): void {
  try {
    const cutoff = today.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(logDir)) {
      if (!f.startsWith(FILE_PREFIX) || !f.endsWith(FILE_SUFFIX)) continue;
      const dayStr = f.slice(FILE_PREFIX.length, f.length - FILE_SUFFIX.length);
      const t = Date.parse(dayStr);
      if (Number.isFinite(t) && t < cutoff) {
        try { fs.unlinkSync(path.join(logDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * Append one recovery event. Never throws.
 */
export function auditLog(event: AuditEvent): void {
  try {
    const now = new Date();
    const day = dayStamp(now);
    const logDir = resolveLogsDirPath();

    if (!fs.existsSync(logDir)) {
      try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
    }

    // Prune at most once per day (cheap guard).
    if (lastPrunedDay !== day) {
      lastPrunedDay = day;
      pruneOldFiles(logDir, now);
    }

    const line = JSON.stringify({ ts: now.toISOString(), ...event }) + '\n';
    fs.appendFileSync(currentFile(logDir, day), line);
  } catch {
    // Swallow — never let audit logging break the caller.
  }
}

/** Retention window in days (for diagnostics / tests). */
export function getRecoveryRetentionDays(): number {
  return RETENTION_DAYS;
}
