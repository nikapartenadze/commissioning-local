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
  | 'estop.check' // an e-stop EPC pass/fail/reset was recorded (safety-critical)
  | 'sync.push.ok'
  | 'sync.push.defer'
  | 'sync.push.drop' // a pending push was discarded — the recovery-critical case
  | 'sync.push.park' // a pending push was PARKED (cloud-rejected/cap) — kept for attention, not lost
  | 'sync.push.force' // operator force-overwrite: local pushed to cloud past the version gate
  | 'sync.reconcile.enqueue' // an orphaned local result/comment (cloud-missing, no queue row) was re-enqueued
  // L2 / Functional-Validation cell events. FV work used to leave NO durable
  // local record (only success-only push COUNTS in the verbose app log), so a
  // wiped/un-synced cell vanished without a trace. These mirror io.test/io.reset:
  | 'l2.cell'        // an FV cell value was written locally (the durable record of the work)
  | 'l2.push.drop'   // an FV cell can NEVER sync (device/column has no cloud mapping) — recovery-critical
  | 'l2.push.park'   // an FV cell push hit the retry cap → PARKED (kept for attention, not deleted)
  | 'l2.reconcile.enqueue' // an orphaned local FV cell (cloud-missing) was re-enqueued
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

// Hot-path caches (2026-07-06 responsiveness hardening). auditLog runs on EVERY
// write (IO test, FV cell, e-stop check, sync drop/park…); it used to
// fs.existsSync() the log dir on every call — a stat syscall per event that,
// under a burst of concurrent writes, adds up on the single event loop. Cache
// the dir-ensured flag + the resolved daily file path so the hot path is a
// single appendFileSync. The append stays SYNCHRONOUS on purpose: the recovery
// log is the durable data-loss forensic trail, so a buffered/async write that
// could drop its tail on a hard crash is the wrong trade here — the win is
// removing the redundant per-call syscalls, not the durable write itself.
let _cachedDir = '';
let _cachedDay = '';
let _cachedPath = '';

export function auditLog(event: AuditEvent): void {
  try {
    const now = new Date();
    const day = dayStamp(now);
    const logDir = resolveLogsDirPath();

    // Recompute the daily file path only on a day rollover or dir change — not
    // the fs.existsSync() stat that used to run on every event (the hot-path win).
    if (day !== _cachedDay || logDir !== _cachedDir) {
      _cachedDay = day;
      _cachedDir = logDir;
      _cachedPath = currentFile(logDir, day);
      if (lastPrunedDay !== day) {
        lastPrunedDay = day;
        pruneOldFiles(logDir, now);
      }
    }

    const line = JSON.stringify({ ts: now.toISOString(), ...event }) + '\n';
    try {
      fs.appendFileSync(_cachedPath, line);
    } catch {
      // The log dir may not exist yet (first write / it was removed). Create it
      // and retry ONCE — this self-heal replaces the per-call existsSync while
      // still guaranteeing the durable append lands.
      try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
      fs.appendFileSync(_cachedPath, line);
    }
  } catch {
    // Swallow — never let audit logging break the caller.
  }
}

/** Retention window in days (for diagnostics / tests). */
export function getRecoveryRetentionDays(): number {
  return RETENTION_DAYS;
}
