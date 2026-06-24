/**
 * Daily-rotating file logger with time-based AND size-based retention.
 *
 * Replaces the old 10MB×3 (30MB cap) rotation, which could not hold "everything
 * for 2 weeks" under multi-MCM load. Each base file (e.g. app.log) is written as
 * a per-day file (app-YYYY-MM-DD.log); files older than LOG_RETENTION_DAYS
 * (default 14) are pruned.
 *
 * Time-based rotation alone is NOT enough: a single day's file had no upper
 * bound, so a runaway log/error loop on one day grew app-2026-06-20.log to
 * 127 MB and errors-2026-06-20.log to another 127 MB (~244 MB observed
 * 2026-06-24) while staying inside the 14-day window. A per-file SIZE cap caps
 * each dated file at LOG_MAX_FILE_BYTES (default 50 MB); when exceeded the file
 * is rolled to <name>.N and at most LOG_MAX_ROLLS (default 3) rolls are kept, so
 * the worst case for any one base on any one day is bounded at
 * ~LOG_MAX_FILE_BYTES × (LOG_MAX_ROLLS + 1).
 *
 * Never throws.
 */

import fs from 'fs';
import path from 'path';

const RETENTION_DAYS = (() => {
  const n = parseInt(process.env.LOG_RETENTION_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
})();

const MAX_FILE_BYTES = (() => {
  const n = parseInt(process.env.LOG_MAX_FILE_BYTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024; // 50 MB
})();

const MAX_ROLLS = (() => {
  const n = parseInt(process.env.LOG_MAX_ROLLS || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
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
    // Match the dated file (app-YYYY-MM-DD.log) AND its size-rolls
    // (app-YYYY-MM-DD.log.1, .2 …) so old size-rolls also age out.
    const escExt = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${prefix}(\\d{4}-\\d{2}-\\d{2})${escExt}(?:\\.\\d+)?$`);
    for (const f of fs.readdirSync(dir)) {
      const m = re.exec(f);
      if (!m) continue;
      const t = Date.parse(m[1]);
      if (Number.isFinite(t) && t < cutoff) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * When `file` is at/over the size cap, roll it: <file>.(N-1)→<file>.N, file→<file>.1,
 * dropping anything past MAX_ROLLS. Bounds a single day's growth. Best-effort.
 */
function rollIfOversized(file: string): void {
  try {
    let size: number;
    try { size = fs.statSync(file).size; } catch { return; } // no file yet → nothing to roll
    if (size < MAX_FILE_BYTES) return;

    // Drop the oldest roll that would fall off the end.
    const oldest = `${file}.${MAX_ROLLS}`;
    try { if (fs.existsSync(oldest)) fs.unlinkSync(oldest); } catch { /* ignore */ }

    // Shift .N-1 → .N down to .1 → .2.
    for (let i = MAX_ROLLS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch { /* ignore */ }
    }

    // Current → .1 (only kept if rolls are enabled; otherwise just truncate).
    if (MAX_ROLLS >= 1) {
      try { fs.renameSync(file, `${file}.1`); } catch { /* ignore */ }
    } else {
      try { fs.truncateSync(file, 0); } catch { /* ignore */ }
    }
  } catch { /* ignore — logging must never throw */ }
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
    const file = datedPath(base, day);
    rollIfOversized(file); // cap a single day's file so it can't grow unbounded
    fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
  } catch { /* ignore — logging must never throw */ }
}

export function getLogRetentionDays(): number {
  return RETENTION_DAYS;
}

export function getLogMaxFileBytes(): number {
  return MAX_FILE_BYTES;
}

export function getLogMaxRolls(): number {
  return MAX_ROLLS;
}
