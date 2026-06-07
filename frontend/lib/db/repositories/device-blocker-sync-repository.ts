import { db } from '@/lib/db-sqlite'

/**
 * Offline queue for device-level VFD bump-test blocker propagation.
 *
 * Rows are drained oldest-first by the AutoSync push loop and POSTed to the
 * cloud's `/api/sync/device-blocker` endpoint, which resolves the shared
 * `Devices` row and writes ONLY the two blocker columns. See
 * frontend/specs/2026-06-04-vfd-bump-blocker-design.md and the "Shared
 * contracts" section of the plan.
 *
 * Mirrors the structure of pending-sync-repository.ts: a thin set of pure
 * functions over the better-sqlite3 singleton.
 */

/** One DeviceBlockerPendingSyncs row, camelCased. Mirrors the table columns. */
export interface DeviceBlockerSyncRow {
  id: number
  subsystemId: number
  deviceName: string
  op: 'set' | 'clear'
  blockerResponsibleParty: string | null
  blockerDescription: string | null
  expectedParty: string | null
  expectedDescription: string | null
  updatedBy: string | null
  timestamp: string | null
  createdAt: string | null
  retryCount: number
  lastError: string | null
}

interface RawRow {
  id: number
  SubsystemId: number
  DeviceName: string
  Op: string
  BlockerResponsibleParty: string | null
  BlockerDescription: string | null
  ExpectedParty: string | null
  ExpectedDescription: string | null
  UpdatedBy: string | null
  Timestamp: string | null
  CreatedAt: string | null
  RetryCount: number
  LastError: string | null
}

function mapRow(r: RawRow): DeviceBlockerSyncRow {
  return {
    id: r.id,
    subsystemId: r.SubsystemId,
    deviceName: r.DeviceName,
    op: r.Op as 'set' | 'clear',
    blockerResponsibleParty: r.BlockerResponsibleParty,
    blockerDescription: r.BlockerDescription,
    expectedParty: r.ExpectedParty,
    expectedDescription: r.ExpectedDescription,
    updatedBy: r.UpdatedBy,
    timestamp: r.Timestamp,
    createdAt: r.CreatedAt,
    retryCount: r.RetryCount,
    lastError: r.LastError,
  }
}

/**
 * Enqueue a 'set' op: assign a blocker (party + description) to a device.
 * Returns the new row id.
 */
export function enqueueDeviceBlockerSet(input: {
  subsystemId: number
  deviceName: string
  party: string
  description: string
  updatedBy?: string
}): number {
  const result = db
    .prepare(
      `INSERT INTO DeviceBlockerPendingSyncs
         (SubsystemId, DeviceName, Op, BlockerResponsibleParty, BlockerDescription, UpdatedBy, Timestamp, RetryCount)
       VALUES (?, ?, 'set', ?, ?, ?, ?, 0)`,
    )
    .run(
      input.subsystemId,
      input.deviceName,
      input.party,
      input.description,
      input.updatedBy ?? null,
      new Date().toISOString(),
    )
  return Number(result.lastInsertRowid)
}

/**
 * Enqueue a 'clear' op: ask the cloud to null the device blocker, but ONLY if
 * the current cloud values still match the expected pair (conditional clear).
 * Returns the new row id.
 */
export function enqueueDeviceBlockerClear(input: {
  subsystemId: number
  deviceName: string
  expectedParty: string
  expectedDescription: string
  updatedBy?: string
}): number {
  const result = db
    .prepare(
      `INSERT INTO DeviceBlockerPendingSyncs
         (SubsystemId, DeviceName, Op, ExpectedParty, ExpectedDescription, UpdatedBy, Timestamp, RetryCount)
       VALUES (?, ?, 'clear', ?, ?, ?, ?, 0)`,
    )
    .run(
      input.subsystemId,
      input.deviceName,
      input.expectedParty,
      input.expectedDescription,
      input.updatedBy ?? null,
      new Date().toISOString(),
    )
  return Number(result.lastInsertRowid)
}

/**
 * List queued blocker syncs, oldest-first (drain order). Optional limit.
 */
export function listDeviceBlockerSyncs(limit?: number): DeviceBlockerSyncRow[] {
  const sql =
    'SELECT * FROM DeviceBlockerPendingSyncs ORDER BY CreatedAt ASC, id ASC' +
    (limit !== undefined ? ' LIMIT ?' : '')
  const rows = (limit !== undefined
    ? db.prepare(sql).all(limit)
    : db.prepare(sql).all()) as RawRow[]
  return rows.map(mapRow)
}

/**
 * Delete a queued blocker sync (after a successful cloud push).
 */
export function deleteDeviceBlockerSync(id: number): void {
  db.prepare('DELETE FROM DeviceBlockerPendingSyncs WHERE id = ?').run(id)
}

/**
 * Record a failed push attempt: bump RetryCount and store the last error.
 * Mirror of pendingSyncRepository.recordFailure — only call this when the
 * cloud actually gave a verdict on the row (see sync-failure-classification.ts).
 */
export function recordDeviceBlockerSyncFailure(id: number, error: string): void {
  db.prepare(
    'UPDATE DeviceBlockerPendingSyncs SET RetryCount = RetryCount + 1, LastError = ? WHERE id = ?',
  ).run(error, id)
}

/**
 * Record a network-level failure WITHOUT burning a retry-cap strike. The row
 * is still good — it just couldn't reach the cloud (offline / timeout / 5xx /
 * 401). Keeps LastError fresh for diagnostics. Mirror of
 * pendingSyncRepository.recordTransientFailure.
 */
export function recordDeviceBlockerSyncTransientFailure(id: number, error: string): void {
  db.prepare('UPDATE DeviceBlockerPendingSyncs SET LastError = ? WHERE id = ?').run(error, id)
}
