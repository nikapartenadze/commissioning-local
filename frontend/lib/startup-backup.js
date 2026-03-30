/**
 * Startup Database Backup
 *
 * Copies the SQLite database to backups/ on server start.
 * Keeps the last 5 startup backups to avoid filling the disk.
 * Safe to call from both dev and production servers.
 */

const fs = require('fs');
const path = require('path');

function createStartupBackup() {
  try {
    const dbPath = path.join(__dirname, '..', 'prisma', 'database.db');
    const backupDir = path.join(__dirname, '..', 'backups');

    if (!fs.existsSync(dbPath)) {
      console.log('[Backup] No database file found, skipping startup backup');
      return;
    }

    // Create backups directory if it doesn't exist
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `database-${timestamp}-startup.db`);

    fs.copyFileSync(dbPath, backupPath);
    const sizeMB = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(1);
    console.log(`[Backup] Startup backup created: ${path.basename(backupPath)} (${sizeMB} MB)`);

    // Clean up old startup backups — keep last 5
    const startupBackups = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('-startup.db'))
      .sort()
      .reverse();

    for (const old of startupBackups.slice(5)) {
      fs.unlinkSync(path.join(backupDir, old));
      console.log(`[Backup] Removed old startup backup: ${old}`);
    }
  } catch (err) {
    console.error('[Backup] Startup backup failed (non-fatal):', err.message);
  }
}

module.exports = { createStartupBackup };
