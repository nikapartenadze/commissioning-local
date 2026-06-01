/**
 * Database Backups — startup + periodic snapshots with time-based retention.
 *
 * Creates self-contained SQLite snapshots in backups/:
 *   - one on server start (database-<ts>-startup.db)
 *   - one every BACKUP_INTERVAL_HOURS (default 6) while running (…-periodic.db)
 *
 * Retention: keep snapshots within BACKUP_RETENTION_DAYS (default 14), and ALWAYS
 * keep the newest MIN_KEEP regardless of age (so a long idle period never leaves
 * zero backups). These coarse snapshots back up the fine-grained recovery audit
 * log (lib/logging/recovery-log) for full data recovery.
 *
 * Safe to call from both dev and production servers. Never throws fatally.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveDatabasePath, resolveBackupsDirPath } = require('./storage-paths');

const RETENTION_DAYS = (() => {
  const n = parseInt(process.env.BACKUP_RETENTION_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
})();
const MIN_KEEP = 3;

function pruneBackups(backupDir) {
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('database-') && f.endsWith('.db'))
      .map((f) => ({ f, m: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m); // newest first

    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (let i = MIN_KEEP; i < files.length; i++) {
      if (files[i].m < cutoff) {
        try {
          fs.unlinkSync(path.join(backupDir, files[i].f));
          console.log(`[Backup] Pruned old backup: ${files[i].f}`);
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
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
        pruneBackups(backupDir);
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

let periodicTimer = null;
function startPeriodicBackups(intervalHours) {
  if (periodicTimer) return;
  const hrs = Number(intervalHours) > 0
    ? Number(intervalHours)
    : (parseFloat(process.env.BACKUP_INTERVAL_HOURS || '') || 6);
  periodicTimer = setInterval(() => createBackup('periodic'), hrs * 60 * 60 * 1000);
  if (periodicTimer.unref) periodicTimer.unref();
  console.log(`[Backup] Periodic backups every ${hrs}h, retention ${RETENTION_DAYS} days (min ${MIN_KEEP} kept)`);
}

module.exports = { createStartupBackup, createBackup, startPeriodicBackups, pruneBackups };
