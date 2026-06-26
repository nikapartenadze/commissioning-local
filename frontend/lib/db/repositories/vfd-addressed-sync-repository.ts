import { db } from '@/lib/db-sqlite'

/**
 * Local READ-ONLY mirror of the cloud belt-tracking ADDRESSED flag.
 *
 * ADDRESSED is a handoff flag a MECHANIC sets on a BLOCKED belt VFD on the CLOUD
 * app ("physical issue fixed — re-run the VFD wizard"). It is an annotation on a
 * blocked belt; it never clears the block and never enables tracking (only the
 * wizard clearing the Bump Blocker cell does that).
 *
 * Marking happens ON THE CLOUD ONLY — the field tool does NOT push. The cloud is
 * authoritative; the field pulls the addressed state down (on SSE reconnect /
 * when the VFD tab opens) and UPSERTS it into the local VfdAddressed table so
 * the VFD Commissioning view can show a read-only ADDRESSED badge offline.
 *
 * Keyed by (SubsystemId, DeviceName) — exactly what the cloud
 * GET /api/sync/vfd-addressed contract returns.
 */

/** Local ADDRESSED state for one belt VFD. */
export interface VfdAddressedState {
  subsystemId: number
  deviceName: string
  addressed: boolean
  addressedBy: string | null
  addressedAt: string | null
}

/** One ADDRESSED row as returned by the cloud GET /api/sync/vfd-addressed. */
export interface CloudVfdAddressedRow {
  deviceName: string
  addressed: boolean
  addressedBy?: string | null
  addressedAt?: string | null
}

/** Read all local ADDRESSED states (for merging into the VFD/belt read). */
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

/**
 * UPSERT cloud-authoritative ADDRESSED rows for one subsystem into the local
 * VfdAddressed mirror. Called by the cloud→field pull.
 *
 * The cloud is the sole authority, so this REPLACES the local rows for the
 * subsystem with exactly what the cloud returned: any local device NOT present
 * in `rows` is cleared (the cloud no longer considers it addressed — e.g. the
 * blocker was cleared, or the mechanic un-pressed it). Runs in a single
 * transaction so the mirror is never half-applied.
 *
 * Returns the number of rows written.
 */
export function upsertVfdAddressedFromCloud(
  subsystemId: number,
  rows: CloudVfdAddressedRow[],
): number {
  const upsert = db.prepare(
    `INSERT INTO VfdAddressed (SubsystemId, DeviceName, Addressed, AddressedBy, AddressedAt)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(SubsystemId, DeviceName) DO UPDATE SET
       Addressed   = excluded.Addressed,
       AddressedBy = excluded.AddressedBy,
       AddressedAt = excluded.AddressedAt`,
  )

  const tx = db.transaction(() => {
    // Cloud is authoritative for this subsystem: drop the prior mirror and
    // rewrite it, so an unlisted device (no longer addressed cloud-side) is
    // cleared rather than left stale.
    db.prepare('DELETE FROM VfdAddressed WHERE SubsystemId = ?').run(subsystemId)
    let written = 0
    for (const r of rows) {
      const name = typeof r.deviceName === 'string' ? r.deviceName.trim() : ''
      if (!name) continue
      const addressed = r.addressed ? 1 : 0
      upsert.run(
        subsystemId,
        name,
        addressed,
        addressed ? r.addressedBy ?? null : null,
        addressed ? r.addressedAt ?? null : null,
      )
      written++
    }
    return written
  })

  return tx()
}
