/**
 * Belt Tracking — Mechanics Page Types
 *
 * Shapes shared by the read endpoint, the React hook, and the UI.
 * Phase 1 — sync writes use the existing L2 cell endpoint, so there is
 * no separate write payload here.
 */

/** Sentinel string written by the v2.20 migration when the auto-tracked
 *  PLC tag was retired. Treat as "not tracked" everywhere. */
export const BELT_TRACKED_INVALIDATED = '__invalidated_v2.20__'

/** What the mechanic writes when marking a belt tracked. Stored in
 *  `L2CellValues.Value` so that the cloud commissioning app and the
 *  existing FV grid both render the same string. */
export const BELT_TRACKED_VALUE = 'Yes'

/**
 * Treats any non-empty, non-sentinel cell value as "tracked".
 * Empty string and null are explicitly not tracked.
 */
export function isTrackedValue(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (trimmed === BELT_TRACKED_INVALIDATED) return false
  return true
}

/** A single VFD's belt-tracking state, one row in the mechanics view. */
export interface VfdRow {
  /** L2Devices.id — the cell-write endpoint takes this */
  deviceId: number
  deviceName: string
  /** Mcm grouping (e.g. "MCM09"). */
  mcm: string | null
  /** Subsystem name (e.g. "Non-Conveyable 5 to 1 PH1"). */
  subsystem: string | null
  /** Tech finished controls verification (Step 4 of the wizard). */
  ready: boolean
  readyAt: string | null
  readyBy: string | null
  /** Mechanic has marked the belt tracked. */
  tracked: boolean
  trackedAt: string | null
  trackedBy: string | null
  /** L2CellValues.Version for the Belt Tracked cell — used for
   *  optimistic-concurrency staleness checks. 0 if no row yet. */
  version: number
}

/** Body of a successful GET /api/belt-tracking response. */
export interface BeltTrackingResponse {
  /** L2Columns.id for "Belt Tracked" — the client uses this when
   *  posting to /api/l2/cell, so it doesn't have to look up columns
   *  separately. */
  beltTrackedColumnId: number
  vfds: VfdRow[]
}

/** Error payload from GET /api/belt-tracking. */
export interface BeltTrackingError {
  error: string
  code: 'no_subsystem' | 'no_belt_column' | 'unknown'
}

/**
 * Live status of the cloud sync pipeline as surfaced in the header pill.
 *
 * - `online`            cloud reachable, queue empty
 * - `syncing`           cloud reachable, queue has work pending
 * - `offline_pending`   cloud unreachable but local writes still saved
 * - `server_unreachable` browser can't even reach the field server itself
 */
export type SyncPillState =
  | { kind: 'online' }
  | { kind: 'syncing'; pending: number }
  | { kind: 'offline_pending'; pending: number }
  | { kind: 'server_unreachable' }
