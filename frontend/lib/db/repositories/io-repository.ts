import { db } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { enrichIo, IoWithComputed, TestConstants } from '../index'

export interface UpdateResultParams {
  id: number
  result: string
  comments?: string | null
  timestamp?: string
}

export interface CreateIoParams {
  subsystemId: number
  name: string
  description?: string | null
  order?: number | null
  tagType?: string | null
  networkDeviceName?: string | null
}

export interface IoFilters {
  subsystemId?: number
  result?: string | null
  hasResult?: boolean
  tagType?: string
  search?: string
}

/**
 * Repository for Io CRUD operations (better-sqlite3)
 */
export const ioRepository = {
  /**
   * Get all IOs with optional filtering
   */
  getAll(filters?: IoFilters): IoWithComputed[] {
    const conditions: string[] = []
    const params: any[] = []

    if (filters?.subsystemId) {
      conditions.push('SubsystemId = ?')
      params.push(filters.subsystemId)
    }

    if (filters?.result !== undefined) {
      if (filters.result === null) {
        conditions.push('Result IS NULL')
      } else {
        conditions.push('Result = ?')
        params.push(filters.result)
      }
    }

    if (filters?.hasResult !== undefined) {
      conditions.push(filters.hasResult ? 'Result IS NOT NULL' : 'Result IS NULL')
    }

    if (filters?.tagType) {
      conditions.push('TagType = ?')
      params.push(filters.tagType)
    }

    if (filters?.search) {
      conditions.push('(Name LIKE ? OR Description LIKE ?)')
      params.push(`%${filters.search}%`, `%${filters.search}%`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const ios = db.prepare(`SELECT * FROM Ios ${where} ORDER BY "Order" ASC, id ASC`).all(...params) as Io[]

    return ios.map(enrichIo)
  },

  /**
   * Get IO by ID
   */
  getById(id: number): IoWithComputed | null {
    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(id) as Io | undefined
    return io ? enrichIo(io) : null
  },

  /**
   * Get IO by ID with test history
   */
  getByIdWithHistory(id: number) {
    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(id) as Io | undefined
    if (!io) return null
    const testHistories = db.prepare(
      'SELECT * FROM TestHistories WHERE IoId = ? ORDER BY Timestamp DESC'
    ).all(id)
    return { ...enrichIo(io), testHistories }
  },

  /**
   * Get IOs by subsystem ID
   */
  getBySubsystemId(subsystemId: number): IoWithComputed[] {
    return this.getAll({ subsystemId })
  },

  /**
   * Get untested IOs
   */
  getUntested(subsystemId?: number): IoWithComputed[] {
    return this.getAll({ subsystemId, result: null })
  },

  /**
   * Get passed IOs
   */
  getPassed(subsystemId?: number): IoWithComputed[] {
    return this.getAll({ subsystemId, result: TestConstants.RESULT_PASSED })
  },

  /**
   * Get failed IOs
   */
  getFailed(subsystemId?: number): IoWithComputed[] {
    return this.getAll({ subsystemId, result: TestConstants.RESULT_FAILED })
  },

  /**
   * Update IO test result
   */
  updateResult(params: UpdateResultParams): IoWithComputed {
    const { id, result, comments, timestamp = new Date().toISOString() } = params

    db.prepare(
      'UPDATE Ios SET Result = ?, Comments = ?, Timestamp = ?, Version = Version + 1 WHERE id = ?'
    ).run(result, comments ?? null, timestamp, id)

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(id) as Io
    return enrichIo(io)
  },

  /**
   * Clear test result for an IO
   */
  clearResult(id: number): IoWithComputed {
    db.prepare(
      'UPDATE Ios SET Result = NULL, Comments = NULL, Timestamp = NULL, Version = Version + 1 WHERE id = ?'
    ).run(id)

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(id) as Io
    return enrichIo(io)
  },

  /**
   * Update IO tag type
   */
  updateTagType(id: number, tagType: string | null): IoWithComputed {
    db.prepare('UPDATE Ios SET TagType = ? WHERE id = ?').run(tagType, id)

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(id) as Io
    return enrichIo(io)
  },

  /**
   * Update cloud sync timestamp
   */
  updateCloudSyncedAt(id: number, syncedAt: Date = new Date()): Io {
    db.prepare('UPDATE Ios SET CloudSyncedAt = ? WHERE id = ?').run(syncedAt.toISOString(), id)
    return db.prepare('SELECT * FROM Ios WHERE id = ?').get(id) as Io
  },

  /**
   * Bulk update cloud sync timestamps
   */
  bulkUpdateCloudSyncedAt(ids: number[], syncedAt: Date = new Date()): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    db.prepare(
      `UPDATE Ios SET CloudSyncedAt = ? WHERE id IN (${placeholders})`
    ).run(syncedAt.toISOString(), ...ids)
  },

  /**
   * Get IOs that need syncing (updated after last cloud sync)
   */
  getUnsynced(): IoWithComputed[] {
    const ios = db.prepare(
      'SELECT * FROM Ios WHERE Result IS NOT NULL AND (CloudSyncedAt IS NULL) ORDER BY Timestamp ASC'
    ).all() as Io[]

    return ios.map(enrichIo)
  },

  /**
   * Create a new IO
   */
  create(params: CreateIoParams): IoWithComputed {
    const result = db.prepare(
      'INSERT INTO Ios (SubsystemId, Name, Description, "Order", TagType, NetworkDeviceName, Version) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(
      params.subsystemId,
      params.name,
      params.description ?? null,
      params.order ?? null,
      params.tagType ?? null,
      params.networkDeviceName ?? null,
    )

    const io = db.prepare('SELECT * FROM Ios WHERE id = ?').get(result.lastInsertRowid) as Io
    return enrichIo(io)
  },

  /**
   * Bulk create IOs
   */
  bulkCreate(ios: CreateIoParams[]): number {
    const stmt = db.prepare(
      'INSERT INTO Ios (SubsystemId, Name, Description, "Order", TagType, NetworkDeviceName, Version) VALUES (?, ?, ?, ?, ?, ?, 0)'
    )

    const insertAll = db.transaction(() => {
      let count = 0
      for (const io of ios) {
        stmt.run(
          io.subsystemId,
          io.name,
          io.description ?? null,
          io.order ?? null,
          io.tagType ?? null,
          io.networkDeviceName ?? null,
        )
        count++
      }
      return count
    })

    return insertAll()
  },

  /**
   * Delete IO by ID
   */
  delete(id: number): void {
    db.prepare('DELETE FROM Ios WHERE id = ?').run(id)
  },

  /**
   * Delete all IOs for a subsystem
   */
  deleteBySubsystemId(subsystemId: number): number {
    const result = db.prepare('DELETE FROM Ios WHERE SubsystemId = ?').run(subsystemId)
    return result.changes
  },

  /**
   * Delete all IOs
   */
  deleteAll(): number {
    const result = db.prepare('DELETE FROM Ios').run()
    return result.changes
  },

  /**
   * Get distinct tag types
   */
  getDistinctTagTypes(): string[] {
    const rows = db.prepare(
      'SELECT DISTINCT TagType FROM Ios WHERE TagType IS NOT NULL'
    ).all() as { TagType: string }[]
    return rows.map(r => r.TagType)
  },

  /**
   * Get distinct network device names
   */
  getDistinctNetworkDevices(): string[] {
    const rows = db.prepare(
      'SELECT DISTINCT NetworkDeviceName FROM Ios WHERE NetworkDeviceName IS NOT NULL'
    ).all() as { NetworkDeviceName: string }[]
    return rows.map(r => r.NetworkDeviceName)
  },

  /**
   * Get IO count
   */
  count(filters?: IoFilters): number {
    const conditions: string[] = []
    const params: any[] = []

    if (filters?.subsystemId) {
      conditions.push('SubsystemId = ?')
      params.push(filters.subsystemId)
    }

    if (filters?.result !== undefined) {
      if (filters.result === null) {
        conditions.push('Result IS NULL')
      } else {
        conditions.push('Result = ?')
        params.push(filters.result)
      }
    }

    if (filters?.hasResult !== undefined) {
      conditions.push(filters.hasResult ? 'Result IS NOT NULL' : 'Result IS NULL')
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return (db.prepare(`SELECT COUNT(*) as count FROM Ios ${where}`).get(...params) as any).count
  },
}

export default ioRepository
