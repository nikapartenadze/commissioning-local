import fs from 'fs'
import path from 'path'

/**
 * Get the path to the backups directory
 */
export function getBackupDbPath(): string {
  return path.resolve(process.cwd(), 'backups')
}

/**
 * Resolve the actual database.db path from DATABASE_URL env var.
 * Prisma resolves relative paths from the schema file location (prisma/),
 * so we do the same here.
 */
export function getDatabasePath(): string {
  const dbUrl = process.env.DATABASE_URL || 'file:./database.db'
  // Strip "file:" prefix
  const relative = dbUrl.replace(/^file:/, '')
  // If absolute path, use as-is
  if (path.isAbsolute(relative)) return relative
  // Resolve relative to prisma/ directory (same as Prisma does)
  return path.resolve(process.cwd(), 'prisma', relative)
}

/**
 * Create a backup of the database
 */
export async function createBackup(reason: string): Promise<{ filename: string; path: string; size: number }> {
  const dbPath = getDatabasePath()
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

  // Copy the database file
  fs.copyFileSync(dbPath, backupPath)

  // Also copy WAL and SHM files if they exist (for consistency)
  const walPath = dbPath + '-wal'
  const shmPath = dbPath + '-shm'
  if (fs.existsSync(walPath)) {
    fs.copyFileSync(walPath, backupPath + '-wal')
  }
  if (fs.existsSync(shmPath)) {
    fs.copyFileSync(shmPath, backupPath + '-shm')
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

  // Also clean up WAL/SHM files if they exist
  const walPath = filePath + '-wal'
  const shmPath = filePath + '-shm'
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath)
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath)
}
