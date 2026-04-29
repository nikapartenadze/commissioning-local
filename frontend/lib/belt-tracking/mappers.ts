import { isTrackedValue, type VfdRow } from './types'

/**
 * Shape returned by the SQL join feeding the belt-tracking endpoint.
 *
 * "Ready for Tracking" is derived from the four cloud-synced L2 cells
 * that represent the controls-verified workflow steps:
 *   - Verify Identity   (pass_fail)
 *   - Motor HP (Field)  (number)
 *   - VFD HP (Field)    (number)
 *   - Check Direction   (pass_fail)
 *
 * We deliberately do NOT use the local-only `VfdControlsVerified`
 * table — that data doesn't sync between field servers, so a tech on
 * one laptop and a mechanic on another would see different states.
 * Reading from L2CellValues keeps the signal consistent across
 * machines and matches what the cloud commissioning app already shows.
 */
export interface RawVfdJoinRow {
  deviceId: number
  deviceName: string
  mcm: string | null
  subsystem: string | null
  // Belt Tracked cell
  trackedValue: string | null
  trackedBy: string | null
  trackedAt: string | null
  trackedVersion: number | null
  // Four controls-verified cells (null = not filled)
  verifyValue: string | null
  verifyAt: string | null
  verifyBy: string | null
  motorHpValue: string | null
  motorHpAt: string | null
  motorHpBy: string | null
  vfdHpValue: string | null
  vfdHpAt: string | null
  vfdHpBy: string | null
  directionValue: string | null
  directionAt: string | null
  directionBy: string | null
}

function isFilled(v: string | null | undefined): boolean {
  if (v === null || v === undefined) return false
  return v.trim().length > 0
}

/**
 * Pure transform from SQL join rows into VfdRow[].
 *
 * Ready logic: all four controls cells must be filled, AND the two
 * pass_fail cells must not be "fail". A failed identity verification
 * or direction check means the VFD shouldn't be tracked yet.
 *
 * readyAt/readyBy take the LATEST of the four cells so the mechanic
 * sees recent attribution, not an arbitrarily-chosen one.
 */
export function mapToVfdRows(rows: RawVfdJoinRow[]): VfdRow[] {
  return rows.map(r => {
    const tracked = isTrackedValue(r.trackedValue)

    const allFilled =
      isFilled(r.verifyValue) &&
      isFilled(r.motorHpValue) &&
      isFilled(r.vfdHpValue) &&
      isFilled(r.directionValue)
    const noFail =
      r.verifyValue?.toLowerCase() !== 'fail' &&
      r.directionValue?.toLowerCase() !== 'fail'
    const ready = allFilled && noFail

    let readyAt: string | null = null
    let readyBy: string | null = null
    if (ready) {
      const candidates: { at: string | null; by: string | null }[] = [
        { at: r.verifyAt, by: r.verifyBy },
        { at: r.motorHpAt, by: r.motorHpBy },
        { at: r.vfdHpAt, by: r.vfdHpBy },
        { at: r.directionAt, by: r.directionBy },
      ]
      const valid = candidates.filter(c => c.at !== null) as { at: string; by: string | null }[]
      if (valid.length > 0) {
        const latest = valid.reduce((acc, c) => (c.at > acc.at ? c : acc))
        readyAt = latest.at
        readyBy = latest.by
      }
    }

    return {
      deviceId: r.deviceId,
      deviceName: r.deviceName,
      mcm: r.mcm,
      subsystem: r.subsystem,
      ready,
      readyAt,
      readyBy,
      tracked,
      trackedAt: tracked ? r.trackedAt : null,
      trackedBy: tracked ? r.trackedBy : null,
      version: r.trackedVersion ?? 0,
    }
  })
}
