import { db } from '@/lib/db-sqlite'

/**
 * Local READ-ONLY mirror of cloud VFD commissioning BLOCKERS.
 *
 * A blocker ("belt is slipping / not moving — Mechanical") is raised on ONE
 * field box (the VFD wizard writes the Bump Blocker L2 cell + enqueues a
 * DeviceBlockerPendingSyncs push). It flows UP to the cloud, but historically
 * there was NO path back DOWN — so a blocker raised on box A was invisible on
 * box B, and box B computed belt-tracking readiness as if the belt were fine.
 * That is the 2026-07-16 MCM15 divergence (cloud 62 ready / 11 blocked vs a
 * local box 73 ready / 0 blocked).
 *
 * The cloud is authoritative (it merges EVERY box's blockers), so the field
 * PULLS this state down and mirrors it here; the VFD Commissioning view then
 * shows blocked belts on every box. This table never drives a push — raising and
 * clearing still go through the wizard + the DeviceBlockerPendingSyncs outbox.
 *
 * Mirrors vfd-addressed-sync-repository.ts: thin pure functions over the
 * better-sqlite3 singleton, keyed by (SubsystemId, DeviceName).
 */

/** Local mirrored blocker state for one belt VFD. */
export interface VfdBlockerState {
  subsystemId: number
  deviceName: string
  party: string | null
  description: string | null
  updatedBy: string | null
  updatedAt: string | null
  addressedBy: string | null
  addressedAt: string | null
}

/** One blocker row as returned by the cloud GET /api/sync/vfd-blockers. */
export interface CloudVfdBlockerRow {
  deviceName: string
  party?: string | null
  description?: string | null
  updatedBy?: string | null
  updatedAt?: string | null
  addressedBy?: string | null
  addressedAt?: string | null
}

/** Read all mirrored blocker states (for merging into the VFD/belt read). */
export function listVfdBlockerStates(): VfdBlockerState[] {
  const rows = db
    .prepare(
      'SELECT SubsystemId, DeviceName, Party, Description, UpdatedBy, UpdatedAt, AddressedBy, AddressedAt FROM VfdBlocker',
    )
    .all() as Array<{
    SubsystemId: number
    DeviceName: string
    Party: string | null
    Description: string | null
    UpdatedBy: string | null
    UpdatedAt: string | null
    AddressedBy: string | null
    AddressedAt: string | null
  }>
  return rows.map(r => ({
    subsystemId: r.SubsystemId,
    deviceName: r.DeviceName,
    party: r.Party,
    description: r.Description,
    updatedBy: r.UpdatedBy,
    updatedAt: r.UpdatedAt,
    addressedBy: r.AddressedBy,
    addressedAt: r.AddressedAt,
  }))
}

/**
 * Device names (lower-cased) with an ACTIVE local blocker op still in flight for
 * this subsystem. For these, the LOCAL intent wins over the cloud mirror: the
 * tech just raised or cleared a blocker on THIS box and it hasn't round-tripped
 * yet. We must not let a stale cloud value overwrite it (a just-cleared blocker
 * must not reappear; a just-raised one must not be pre-empted). Parked
 * (DeadLettered=1) rows still count — the operator's intent is unresolved, so we
 * keep deferring to the local cell until they clear the parked queue.
 */
function pendingDeviceNamesLower(subsystemId: number): Set<string> {
  const rows = db
    .prepare(
      'SELECT DISTINCT DeviceName FROM DeviceBlockerPendingSyncs WHERE SubsystemId = ?',
    )
    .all(subsystemId) as Array<{ DeviceName: string }>
  return new Set(rows.map(r => String(r.DeviceName).trim().toLowerCase()))
}

/**
 * UPSERT cloud-authoritative blocker rows for one subsystem into the local
 * VfdBlocker mirror. Called by the cloud→field pull.
 *
 * The cloud is the sole authority for the merged blocker picture, so this
 * REPLACES the subsystem's mirror with exactly what the cloud returned — a
 * device absent from `rows` is unblocked (its blocker was cleared cloud-side).
 *
 * EXCEPTION — never clobber in-flight local intent: a device with an active
 * DeviceBlockerPendingSyncs row (set OR clear) is SKIPPED entirely (no mirror
 * row written for it). Its display is driven by the local Bump Blocker cell,
 * which already reflects the tech's just-made change; the mirror stays out of
 * the way until the push round-trips and a later pull reconciles it.
 *
 * Runs in one transaction so the mirror is never half-applied. Returns the
 * number of mirror rows written.
 */
export function applyVfdBlockersFromCloud(
  subsystemId: number,
  rows: CloudVfdBlockerRow[],
): number {
  const pending = pendingDeviceNamesLower(subsystemId)

  const insert = db.prepare(
    `INSERT INTO VfdBlocker
       (SubsystemId, DeviceName, Party, Description, UpdatedBy, UpdatedAt, AddressedBy, AddressedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(SubsystemId, DeviceName) DO UPDATE SET
       Party       = excluded.Party,
       Description = excluded.Description,
       UpdatedBy   = excluded.UpdatedBy,
       UpdatedAt   = excluded.UpdatedAt,
       AddressedBy = excluded.AddressedBy,
       AddressedAt = excluded.AddressedAt`,
  )

  const tx = db.transaction(() => {
    // Cloud is authoritative for this subsystem: drop the prior mirror and
    // rewrite it, so a device no longer blocked cloud-side is cleared here.
    db.prepare('DELETE FROM VfdBlocker WHERE SubsystemId = ?').run(subsystemId)
    let written = 0
    for (const r of rows) {
      const name = typeof r.deviceName === 'string' ? r.deviceName.trim() : ''
      if (!name) continue
      // In-flight local blocker op for this device → local cell wins; skip.
      if (pending.has(name.toLowerCase())) continue
      insert.run(
        subsystemId,
        name,
        r.party ?? null,
        r.description ?? null,
        r.updatedBy ?? null,
        r.updatedAt ?? null,
        r.addressedBy ?? null,
        r.addressedAt ?? null,
      )
      written++
    }
    return written
  })

  return tx()
}
