/**
 * Backup retention (lib/db/backup.ts → pruneBackups).
 *
 * Regression guard for the 2026-06-16 MCM11 incident: pre-pull auto-backups are
 * full DB copies taken before EVERY pull, and a central server polling N active
 * MCMs every ~15 min generated hundreds/day with no upper bound until the disk
 * filled to ~4 GB. pruneBackups must keep the disk bounded while never touching
 * the live DB and never deleting a just-made recovery point.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmpRoot: string
let backupsDir: string

function writeBackup(name: string, ageMs: number): string {
  const p = path.join(backupsDir, name)
  fs.writeFileSync(p, 'x')
  const t = (Date.now() - ageMs) / 1000
  fs.utimesSync(p, t, t)
  return p
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-retention-'))
  // storage root = dir of DATABASE_URL; backups live in <root>/backups
  process.env.DATABASE_URL = `file:${path.join(tmpRoot, 'database.db')}`
  backupsDir = path.join(tmpRoot, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  delete process.env.BACKUP_RETENTION_KEEP
  delete process.env.BACKUP_RETENTION_MIN_AGE_MS
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  delete process.env.DATABASE_URL
  delete process.env.BACKUP_RETENTION_KEEP
  delete process.env.BACKUP_RETENTION_MIN_AGE_MS
})

describe('pruneBackups', () => {
  it('keeps only the newest BACKUP_RETENTION_KEEP backups and deletes older ones', async () => {
    process.env.BACKUP_RETENTION_KEEP = '5'
    process.env.BACKUP_RETENTION_MIN_AGE_MS = '0' // disable age guard for this test
    const { pruneBackups } = await import('@/lib/db/backup')

    // 20 backups, ages 20h..1h (all older than min-age=0)
    for (let i = 20; i >= 1; i--) {
      writeBackup(`database-2026-06-16T00-${String(i).padStart(2, '0')}-00-000Z-pre-pull-mcm47.db`, i * 60 * 60 * 1000)
    }

    const res = pruneBackups()
    const remaining = fs.readdirSync(backupsDir).filter((f) => f.startsWith('database-'))
    expect(remaining).toHaveLength(5)
    expect(res.deleted).toBe(15)
    // The 5 kept are the youngest (smallest age = minutes 1..5).
    expect(remaining.sort()).toEqual(
      ['01', '02', '03', '04', '05'].map((m) => `database-2026-06-16T00-${m}-00-000Z-pre-pull-mcm47.db`).sort(),
    )
  })

  it('never deletes backups younger than the minimum-age guard, even past the keep count', async () => {
    process.env.BACKUP_RETENTION_KEEP = '2'
    process.env.BACKUP_RETENTION_MIN_AGE_MS = String(60 * 60 * 1000) // 1h
    const { pruneBackups } = await import('@/lib/db/backup')

    // 5 fresh backups (age ~1 min) — all inside the 1h guard.
    for (let i = 1; i <= 5; i++) {
      writeBackup(`database-2026-06-16T01-0${i}-00-000Z-pre-pull-mcm38.db`, 60 * 1000)
    }
    const res = pruneBackups()
    expect(res.deleted).toBe(0)
    expect(fs.readdirSync(backupsDir).filter((f) => f.startsWith('database-'))).toHaveLength(5)
  })

  it('only touches database-*.db files — leaves the live DB and unrelated files alone', async () => {
    process.env.BACKUP_RETENTION_KEEP = '1'
    process.env.BACKUP_RETENTION_MIN_AGE_MS = '0'
    const { pruneBackups } = await import('@/lib/db/backup')

    writeBackup('database-2026-06-16T00-01-00-000Z-pre-pull-mcm47.db', 5 * 60 * 60 * 1000)
    writeBackup('database-2026-06-16T00-02-00-000Z-pre-pull-mcm47.db', 4 * 60 * 60 * 1000)
    // Files that must NEVER be pruned by this routine:
    const unrelated = path.join(backupsDir, 'README.txt')
    fs.writeFileSync(unrelated, 'keep me')
    const foreignDb = path.join(backupsDir, 'mydata.db') // .db but not the backup prefix
    fs.writeFileSync(foreignDb, 'keep me too')
    // The live DB sits in the storage root, not the backups dir — assert untouched.
    const liveDb = path.join(tmpRoot, 'database.db')
    fs.writeFileSync(liveDb, 'LIVE')

    pruneBackups()

    expect(fs.existsSync(unrelated)).toBe(true)
    expect(fs.existsSync(foreignDb)).toBe(true)
    expect(fs.readFileSync(liveDb, 'utf8')).toBe('LIVE')
    // Of the two real backups, only the newest survives.
    const remaining = fs.readdirSync(backupsDir).filter((f) => f.startsWith('database-') && f.endsWith('.db'))
    expect(remaining).toEqual(['database-2026-06-16T00-02-00-000Z-pre-pull-mcm47.db'])
  })

  it('is a safe no-op when the backups directory does not exist', async () => {
    fs.rmSync(backupsDir, { recursive: true, force: true })
    const { pruneBackups } = await import('@/lib/db/backup')
    expect(() => pruneBackups()).not.toThrow()
    expect(pruneBackups()).toEqual({ deleted: 0, kept: 0 })
  })
})
