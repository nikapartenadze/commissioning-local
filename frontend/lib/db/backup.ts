import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { resolveBackupsDirPath, resolveDatabasePath } from '@/lib/storage-paths'

/**
 * Get the path to the backups directory
 */
export function getBackupDbPath(): string {
  return resolveBackupsDirPath()
}

/**
 * Create a backup of the database
 */
export async function createBackup(reason: string): Promise<{ filename: string; path: string; size: number }> {
  const dbPath = resolveDatabasePath()
  const backupsDir = getBackupDbPath()

  // Ensure backups directory exists
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true })
  }

  // Sanitize reason for filename
  const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `database-${timestamp}-${safeReason}.db`
  const backupPath = path.join(backupsDir, filename)

  // Snapshot method (2026-07-08 durability audit): prefer `VACUUM INTO` — it
  // produces a transactionally-consistent, compacted single-file snapshot even
  // with WAL mode active (no torn copies, no separate -wal/-shm to worry
  // about). Fall back to the previous online-backup method if VACUUM INTO
  // throws (older SQLite build / disk edge case) so a backup is ALWAYS taken.
  const snapshotDb = new Database(dbPath, { readonly: true })
  try {
    try {
      snapshotDb.prepare('VACUUM INTO ?').run(backupPath)
    } catch (vacuumErr) {
      console.warn('[backup] VACUUM INTO failed — falling back to online backup API:', vacuumErr)
      // VACUUM INTO refuses to overwrite and may leave a partial file behind
      // on failure — remove it so the fallback writes a clean file.
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath)
      } catch { /* best-effort */ }
      await snapshotDb.backup(backupPath)
    }
  } finally {
    snapshotDb.close()
  }

  const stats = fs.statSync(backupPath)

  // Bound the backups directory. Pre-pull backups are full DB copies taken
  // before EVERY pull; on a central server that polls N active MCMs every
  // ~15 min this is hundreds of full copies/day with no upper bound — the
  // 2026-06-16 MCM11 incident filled the disk to ~4 GB this way. Prune here so
  // the safety net can never become the failure. Best-effort: a prune failure
  // must never fail the backup (and therefore must never abort a pull).
  try {
    pruneBackups()
  } catch (err) {
    console.warn('[backup] prune failed (non-fatal):', err)
  }

  return {
    filename,
    path: backupPath,
    size: stats.size,
  }
}

/**
 * Retention policy for auto-created backups. Two independent bounds, both
 * applied, both respecting a minimum-age guard:
 *
 *  - COUNT: keep at most BACKUP_RETENTION_KEEP newest backups (default 30).
 *  - SIZE:  keep total backup bytes under BACKUP_RETENTION_MAX_BYTES
 *           (default 5 GB) — deletes the oldest until the survivors fit.
 *
 * Backups younger than BACKUP_RETENTION_MIN_AGE_MS (default 1 h) are NEVER
 * pruned, so a burst of pulls can't immediately delete a just-made recovery
 * point (the size cap honors this too — it won't drop fresh backups to fit).
 * Only files matching the auto-backup naming pattern are ever touched; the live
 * database.db lives in a different directory and is never a candidate.
 *
 * Field context (2026-07-01): central boxes accumulated hundreds of files under
 * the old count-only (keep 100) policy + a second disagreeing time-based pruner.
 * This is now the single retention authority; the size cap is the hard bound.
 */
export function pruneBackups(): { deleted: number; kept: number } {
  const keep = Math.max(1, parseInt(process.env.BACKUP_RETENTION_KEEP || '', 10) || 30)
  const minAgeMs = Math.max(
    0,
    parseInt(process.env.BACKUP_RETENTION_MIN_AGE_MS || '', 10) || 60 * 60 * 1000,
  )
  const maxBytes = Math.max(
    0,
    parseInt(process.env.BACKUP_RETENTION_MAX_BYTES || '', 10) || 5 * 1024 * 1024 * 1024,
  )
  const backupsDir = getBackupDbPath()
  if (!fs.existsSync(backupsDir)) return { deleted: 0, kept: 0 }

  const now = Date.now()
  const files = fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith('.db') && f.startsWith('database-'))
    .map((filename) => {
      const filePath = path.join(backupsDir, filename)
      const stat = fs.statSync(filePath)
      return { filePath, mtime: stat.mtimeMs, size: stat.size }
    })
    .sort((a, b) => b.mtime - a.mtime) // newest first

  const toDelete = new Set<string>()
  const deletable = (f: { mtime: number }) => now - f.mtime >= minAgeMs

  // Count bound: everything past the keep window (that's old enough).
  for (const f of files.slice(keep)) {
    if (deletable(f)) toDelete.add(f.filePath)
  }

  // Size bound: sum survivors; if over budget, drop the oldest deletable ones
  // (oldest = end of the newest-first array) until under budget or none remain.
  let survivingBytes = files
    .filter((f) => !toDelete.has(f.filePath))
    .reduce((sum, f) => sum + f.size, 0)
  if (survivingBytes > maxBytes) {
    for (let i = files.length - 1; i >= 0 && survivingBytes > maxBytes; i--) {
      const f = files[i]
      if (toDelete.has(f.filePath) || !deletable(f)) continue
      toDelete.add(f.filePath)
      survivingBytes -= f.size
    }
  }

  let deleted = 0
  for (const filePath of toDelete) {
    try {
      fs.unlinkSync(filePath)
      deleted++
    } catch {
      // best-effort — skip files we can't remove (locked / permissions)
    }
  }
  return { deleted, kept: files.length - deleted }
}

/**
 * List all backups sorted newest first
 */
export async function listBackups(): Promise<Array<{ filename: string; path: string; size: number; createdAt: Date }>> {
  const backupsDir = getBackupDbPath()

  if (!fs.existsSync(backupsDir)) {
    return []
  }

  const files = fs.readdirSync(backupsDir)
  const backups = files
    .filter(f => f.endsWith('.db') && f.startsWith('database-'))
    .map(filename => {
      const filePath = path.join(backupsDir, filename)
      const stats = fs.statSync(filePath)
      return {
        filename,
        path: filePath,
        size: stats.size,
        createdAt: stats.birthtime,
      }
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  return backups
}

/**
 * Delete a specific backup (with path traversal protection)
 */
export async function deleteBackup(filename: string): Promise<void> {
  // Validate filename to prevent path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename')
  }
  if (!filename.endsWith('.db') || !filename.startsWith('database-')) {
    throw new Error('Invalid backup filename')
  }

  const backupsDir = getBackupDbPath()
  const filePath = path.join(backupsDir, filename)

  // Double-check resolved path is within backups dir
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(path.resolve(backupsDir))) {
    throw new Error('Invalid filename')
  }

  if (!fs.existsSync(filePath)) {
    throw new Error('Backup not found')
  }

  fs.unlinkSync(filePath)
}
