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

  const snapshotDb = new Database(dbPath, { readonly: true })
  try {
    await snapshotDb.backup(backupPath)
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
 * Retention policy for auto-created backups.
 *
 * Keeps at most BACKUP_RETENTION_KEEP newest backups (default 300 — generous
 * recovery history while bounding disk at ~300 × DB size). Backups younger
 * than BACKUP_RETENTION_MIN_AGE_MS (default 1 h) are NEVER pruned, so a burst
 * of pulls can't immediately delete a just-made recovery point. Only files
 * matching the auto-backup naming pattern are ever touched; the live
 * database.db is in a different directory and is never a candidate.
 */
export function pruneBackups(): { deleted: number; kept: number } {
  const keep = Math.max(1, parseInt(process.env.BACKUP_RETENTION_KEEP || '', 10) || 300)
  const minAgeMs = Math.max(
    0,
    parseInt(process.env.BACKUP_RETENTION_MIN_AGE_MS || '', 10) || 60 * 60 * 1000,
  )
  const backupsDir = getBackupDbPath()
  if (!fs.existsSync(backupsDir)) return { deleted: 0, kept: 0 }

  const now = Date.now()
  const files = fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith('.db') && f.startsWith('database-'))
    .map((filename) => {
      const filePath = path.join(backupsDir, filename)
      const mtime = fs.statSync(filePath).mtimeMs
      return { filePath, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime) // newest first

  let deleted = 0
  // Everything past the keep window is a deletion candidate, except files
  // still inside the minimum-age guard.
  for (const f of files.slice(keep)) {
    if (now - f.mtime < minAgeMs) continue
    try {
      fs.unlinkSync(f.filePath)
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
