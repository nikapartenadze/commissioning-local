/**
 * Startup Database Backup
 *
 * Creates a self-contained SQLite backup in backups/ on server start.
 * Keeps the last 5 startup backups to avoid filling the disk.
 * Safe to call from both dev and production servers.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveDatabasePath, resolveBackupsDirPath } = require('./storage-paths');

function getDatabasePath() {
  return resolveDatabasePath();
}

function createStartupBackup() {
  try {
    const dbPath = getDatabasePath();
    const backupDir = resolveBackupsDirPath();

    if (!fs.existsSync(dbPath)) {
      console.log('[Backup] No database file found, skipping startup backup');
      return;
    }

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `database-${timestamp}-startup.db`);
    const snapshotDb = new Database(dbPath, { readonly: true });

    snapshotDb.backup(backupPath)
      .then(() => {
        try { snapshotDb.close(); } catch {}
        const sizeMB = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(1);
        console.log(`[Backup] Startup backup created: ${path.basename(backupPath)} (${sizeMB} MB)`);

        const startupBackups = fs.readdirSync(backupDir)
          .filter(f => f.endsWith('-startup.db'))
          .sort()
          .reverse();

        for (const old of startupBackups.slice(5)) {
          fs.unlinkSync(path.join(backupDir, old));
          console.log(`[Backup] Removed old startup backup: ${old}`);
        }
      })
      .catch((backupErr) => {
        try { snapshotDb.close(); } catch {}
        console.error('[Backup] Startup backup failed (non-fatal):', backupErr.message);
      });
  } catch (err) {
    console.error('[Backup] Startup backup failed (non-fatal):', err.message);
  }
}

module.exports = { createStartupBackup };
