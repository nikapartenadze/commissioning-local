/**
 * Daily-rotating file logger with time-based retention.
 *
 * Replaces the old 10MB×3 (30MB cap) rotation, which could not hold "everything
 * for 2 weeks" under multi-MCM load. Each base file (e.g. app.log) is written as
 * a per-day file (app-YYYY-MM-DD.log); files older than LOG_RETENTION_DAYS
 * (default 14) are pruned. No size cap — resource use is acceptable per ops.
 *
 * Never throws.
 */

import fs from 'fs';
import path from 'path';

const RETENTION_DAYS = (() => {
  const n = parseInt(process.env.LOG_RETENTION_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
})();

// base file path -> last day we pruned for it (prune at most once/day/base).
const prunedFor = new Map<string, string>();

function datedPath(base: string, day: string): string {
  const dir = path.dirname(base);
  const ext = path.extname(base);
  const name = path.basename(base, ext);
  return path.join(dir, `${name}-${day}${ext}`);
}

function pruneDaily(base: string, now: Date): void {
  try {
    const dir = path.dirname(base);
    const ext = path.extname(base);
    const name = path.basename(base, ext);
    const prefix = `${name}-`;
    const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith(ext)) continue;
      const dayStr = f.slice(prefix.length, f.length - ext.length);
      const t = Date.parse(dayStr);
      if (Number.isFinite(t) && t < cutoff) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * Append a line to today's dated file derived from `base`. `base` is a nominal
 * path like `<logs>/app.log`; the real file is `<logs>/app-YYYY-MM-DD.log`.
 */
export function appendDailyLog(base: string, line: string): void {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const dir = path.dirname(base);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    if (prunedFor.get(base) !== day) {
      prunedFor.set(base, day);
      pruneDaily(base, now);
    }
    fs.appendFileSync(datedPath(base, day), line.endsWith('\n') ? line : line + '\n');
  } catch { /* ignore — logging must never throw */ }
}

export function getLogRetentionDays(): number {
  return RETENTION_DAYS;
}
