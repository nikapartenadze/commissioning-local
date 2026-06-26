import { db } from '@/lib/db-sqlite'

/**
 * Local state + offline push queue for the belt-tracking ADDRESSED toggle.
 *
 * ADDRESSED is a handoff flag a mechanic sets on a BLOCKED belt VFD ("physical
 * issue fixed — re-run the VFD wizard"). It is an annotation on a blocked belt;
 * it never clears the block and never enables tracking (the wizard clearing the
 * Bump Blocker cell does that). Cloud is authoritative, but the local row
 * reflects the toggle immediately and offline; the queue pushes to the cloud
 * `/api/sync/vfd-addressed` endpoint and the background loop retries.
 *
 * Mirrors device-blocker-sync-repository.ts: thin pure functions over the
 * better-sqlite3 singleton. Keyed by (SubsystemId, DeviceName) — exactly what
 * the cloud contract resolves on.
 */

/** Local ADDRESSED state for one belt VFD. */
export interface VfdAddressedState {
  subsystemId: number
  deviceName: string
  addressed: boolean
  addressedBy: string | null
  addressedAt: string | null
}

/** One VfdAddressedPendingSyncs row, camelCased. */
export interface VfdAddressedSyncRow {
  id: number
  subsystemId: number
  deviceName: string
  addressed: boolean
  updatedBy: string | null
  timestamp: string | null
  createdAt: string | null
  retryCount: number
  lastError: string | null
}

interface RawSyncRow {
  id: number
  SubsystemId: number
  DeviceName: string
  Addressed: number
  UpdatedBy: string | null
  Timestamp: string | null
  CreatedAt: string | null
  RetryCount: number
  LastError: string | null
}

function mapSyncRow(r: RawSyncRow): VfdAddressedSyncRow {
  return {
    id: r.id,
    subsystemId: r.SubsystemId,
    deviceName: r.DeviceName,
    addressed: r.Addressed === 1,
    updatedBy: r.UpdatedBy,
    timestamp: r.Timestamp,
    createdAt: r.CreatedAt,
    retryCount: r.RetryCount,
    lastError: r.LastError,
  }
}

/**
 * Set (or undo) the local ADDRESSED flag for a belt and enqueue a cloud push.
 * Runs in a single transaction so the local state and the queued sync row are
 * always consistent (the UI reads the state immediately, even offline).
 *
 * Coalesces the queue: any earlier un-pushed row for the same (subsystem,
 * device) is replaced so a rapid toggle collapses to the final intent and we
 * never push a stale value. Returns the new queue row id.
 */
export function setVfdAddressed(input: {
  subsystemId: number
  deviceName: string
  addressed: boolean
  updatedBy?: string
}): number {
  const now = new Date().toISOString()
  const updatedBy = input.updatedBy ?? null

  const tx = db.transaction(() => {
    // 1. Local state (immediate, offline-safe).
    db.prepare(
      `INSERT INTO VfdAddressed (SubsystemId, DeviceName, Addressed, AddressedBy, AddressedAt)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(SubsystemId, DeviceName) DO UPDATE SET
         Addressed = excluded.Addressed,
         AddressedBy = CASE WHEN excluded.Addressed = 1 THEN excluded.AddressedBy ELSE NULL END,
         AddressedAt = CASE WHEN excluded.Addressed = 1 THEN excluded.AddressedAt ELSE NULL END`,
    ).run(
      input.subsystemId,
      input.deviceName,
      input.addressed ? 1 : 0,
      input.addressed ? updatedBy : null,
      input.addressed ? now : null,
    )

    // 2. Coalesce: drop any earlier un-pushed intent for this belt.
    db.prepare(
      'DELETE FROM VfdAddressedPendingSyncs WHERE SubsystemId = ? AND DeviceName = ?',
    ).run(input.subsystemId, input.deviceName)

    // 3. Enqueue the push.
    const result = db
      .prepare(
        `INSERT INTO VfdAddressedPendingSyncs
           (SubsystemId, DeviceName, Addressed, UpdatedBy, Timestamp, RetryCount)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(input.subsystemId, input.deviceName, input.addressed ? 1 : 0, updatedBy, now)
    return Number(result.lastInsertRowid)
  })

  return tx()
}

/** Read all local ADDRESSED states (for merging into the belt-tracking read). */
export function listVfdAddressedStates(): VfdAddressedState[] {
  const rows = db
    .prepare(
      'SELECT SubsystemId, DeviceName, Addressed, AddressedBy, AddressedAt FROM VfdAddressed',
    )
    .all() as Array<{
    SubsystemId: number
    DeviceName: string
    Addressed: number
    AddressedBy: string | null
    AddressedAt: string | null
  }>
  return rows.map(r => ({
    subsystemId: r.SubsystemId,
    deviceName: r.DeviceName,
    addressed: r.Addressed === 1,
    addressedBy: r.AddressedBy,
    addressedAt: r.AddressedAt,
  }))
}

/** List queued addressed syncs, oldest-first (drain order). Optional limit. */
export function listVfdAddressedSyncs(limit?: number): VfdAddressedSyncRow[] {
  const sql =
    'SELECT * FROM VfdAddressedPendingSyncs ORDER BY CreatedAt ASC, id ASC' +
    (limit !== undefined ? ' LIMIT ?' : '')
  const rows = (limit !== undefined
    ? db.prepare(sql).all(limit)
    : db.prepare(sql).all()) as RawSyncRow[]
  return rows.map(mapSyncRow)
}

/** Delete a queued addressed sync (after a successful cloud push). */
export function deleteVfdAddressedSync(id: number): void {
  db.prepare('DELETE FROM VfdAddressedPendingSyncs WHERE id = ?').run(id)
}

/**
 * Record a failed push attempt that the cloud actually gave a verdict on: bump
 * RetryCount + store the error. Mirror of recordDeviceBlockerSyncFailure.
 */
export function recordVfdAddressedSyncFailure(id: number, error: string): void {
  db.prepare(
    'UPDATE VfdAddressedPendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?',
  ).run(error, id)
}

/**
 * Record a network-level failure WITHOUT burning a retry-cap strike (offline /
 * timeout / 5xx / 401). Mirror of recordDeviceBlockerSyncTransientFailure.
 */
export function recordVfdAddressedSyncTransientFailure(id: number, error: string): void {
  db.prepare('UPDATE VfdAddressedPendingSyncs SET LastError = ? WHERE id = ?').run(error, id)
}
