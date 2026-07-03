/**
 * Database Backups — startup + periodic snapshots with time-based retention.
 *
 * Creates self-contained SQLite snapshots in backups/:
 *   - one on server start (database-<ts>-startup.db)
 *   - one every BACKUP_INTERVAL_HOURS (default 6) while running (…-periodic.db)
 *
 * Retention: delegated to lib/db/backup.ts pruneBackups() — the single
 * retention authority (BACKUP_RETENTION_KEEP count + BACKUP_RETENTION_MAX_BYTES
 * size bounds, min-age guarded). These coarse snapshots back up the
 * fine-grained recovery audit log (lib/logging/recovery-log) for full recovery.
 *
 * Safe to call from both dev and production servers. Never throws fatally.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveDatabasePath, resolveBackupsDirPath } = require('./storage-paths');

// F14 (2026-07-03 sync audit): retention is owned by lib/db/backup.ts
// pruneBackups() — the single authority (count + size + min-age policy).
// The old day-based pruner here (BACKUP_RETENTION_DAYS, MIN_KEEP=3) ran
// independently on the same directory and could delete recovery points the
// count/size policy meant to keep. This is now a thin delegate. Lazy require:
// dev (tsx) resolves ./db/backup.ts, prod resolves the tsc-compiled .js.
function pruneBackups() {
  try {
    const { pruneBackups: pruneUnified } = require('./db/backup');
    const { deleted, kept } = pruneUnified();
    if (deleted > 0) console.log(`[Backup] Pruned ${deleted} old backup(s), ${kept} kept`);
  } catch (err) {
    console.warn('[Backup] unified prune unavailable (non-fatal):', err && err.message);
  }
}

function createBackup(label) {
  try {
    const dbPath = resolveDatabasePath();
    const backupDir = resolveBackupsDirPath();

    if (!fs.existsSync(dbPath)) {
      console.log('[Backup] No database file found, skipping backup');
      return;
    }
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `database-${timestamp}-${label}.db`);
    const snapshotDb = new Database(dbPath, { readonly: true });

    snapshotDb
      .backup(backupPath)
      .then(() => {
        try { snapshotDb.close(); } catch { /* ignore */ }
        const sizeMB = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(1);
        console.log(`[Backup] ${label} backup created: ${path.basename(backupPath)} (${sizeMB} MB)`);
        pruneBackups();
      })
      .catch((backupErr) => {
        try { snapshotDb.close(); } catch { /* ignore */ }
        console.error(`[Backup] ${label} backup failed (non-fatal):`, backupErr.message);
      });
  } catch (err) {
    console.error('[Backup] backup failed (non-fatal):', err.message);
  }
}

function createStartupBackup() {
  createBackup('startup');
}

// ms from now until the next local `hour`:00 (default 3 AM) — used to align the
// daily snapshot to a quiet overnight window instead of "24h after boot".
function msUntilNextHour(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let periodicTimer = null;
let overnightTimeout = null;
/**
 * Default: ONE overnight snapshot/day (~3 AM local), then every 24h. This
 * replaces the old every-6h cadence that (with permissive retention) piled up
 * hundreds of files on central boxes. Set BACKUP_INTERVAL_HOURS to force the
 * legacy fixed-interval behavior; pass intervalHours to override explicitly.
 */
function startPeriodicBackups(intervalHours) {
  if (periodicTimer || overnightTimeout) return;
  const forcedHrs = Number(intervalHours) > 0
    ? Number(intervalHours)
    : parseFloat(process.env.BACKUP_INTERVAL_HOURS || '');

  if (Number.isFinite(forcedHrs) && forcedHrs > 0) {
    periodicTimer = setInterval(() => createBackup('periodic'), forcedHrs * 60 * 60 * 1000);
    if (periodicTimer.unref) periodicTimer.unref();
    console.log(`[Backup] Periodic backups every ${forcedHrs}h (retention: unified count+size policy in lib/db/backup)`);
    return;
  }

  const hour = 3;
  const firstDelay = msUntilNextHour(hour);
  overnightTimeout = setTimeout(() => {
    createBackup('overnight');
    periodicTimer = setInterval(() => createBackup('overnight'), 24 * 60 * 60 * 1000);
    if (periodicTimer.unref) periodicTimer.unref();
  }, firstDelay);
  if (overnightTimeout.unref) overnightTimeout.unref();
  console.log(`[Backup] Overnight daily backup scheduled (~${Math.round(firstDelay / 3_600_000)}h from now, then every 24h; retention: unified count+size policy in lib/db/backup)`);
}

module.exports = { createStartupBackup, createBackup, startPeriodicBackups, pruneBackups };
