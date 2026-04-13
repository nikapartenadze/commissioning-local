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

  return {
    filename,
    path: backupPath,
    size: stats.size,
  }
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
