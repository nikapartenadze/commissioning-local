import crypto from 'crypto'
import { db } from '@/lib/db-sqlite'
import { BELT_TRACKED_COLUMN_NAME, BELT_TRACKED_VALUE } from '@/lib/vfd-validation-writer'
import { hasAnyMcm, getAggregateStatus } from '@/lib/mcm-registry'

/**
 * BELT-TRACKING TELEMETRY (2026-07-22).
 *
 * WHY THIS EXISTS — a four-hour outage, not a hypothetical.
 *
 * The cloud already knows WHICH instances are connected to WHICH MCM: the
 * heartbeat reports `systemInfo.plc.mcms[]`. What it has never been able to see
 * is what each instance BELIEVES the belt-tracking values are. Every instance
 * asserts Valid_* flags into the SHARED controller from its OWN local L2 copy
 * (see vfd-validation-writer), so N instances on one MCM are N independent
 * writers working from N possibly-divergent copies.
 *
 * On 2026-07-22 four instances were live on MCM15 — two of them sharing the
 * hostname "autstand", so they were not even distinguishable by name. A
 * coordinator untracked belts at 12:37; some instances never received the
 * update and kept re-asserting Belt Tracked, and mechanics could not change
 * belt direction from the keypad for four hours. Finding the writer required
 * remoting into each machine one at a time, because the divergence existed
 * only inside each tool's local SQLite.
 *
 * This collector closes that blind spot: each instance now states, per
 * subsystem, what it thinks is tracked. Two instances on the same MCM with
 * different `fingerprint` values IS the divergence, visible from the fleet
 * page with nobody remoting anywhere.
 */

/** Bounded sample of tracked device cloud-ids per subsystem. */
export const TRACKED_SAMPLE_LIMIT = 15

/** Characters of hex kept from the digest — see `fingerprintOf`. */
const FINGERPRINT_LENGTH = 12

export interface BeltTrackingSubsystemSnapshot {
  /** Local Subsystems.id — joins to `plc.mcms[].subsystemId` in the same payload. */
  subsystemId: number
  /** Devices on this subsystem's VFD/APF sheets whose Belt Tracked cell == 'Yes'. */
  trackedCount: number
  /** All devices on this subsystem's VFD/APF sheets, tracked or not. */
  totalDevices: number
  /**
   * Newest UpdatedAt across this subsystem's Belt Tracked cells, as stored
   * locally. An instance still asserting a value the coordinator revoked shows
   * an OLDER stamp than its peers — the 12:37 case, made visible.
   */
  lastLocalUpdateAt: string | null
  /**
   * Short stable digest over the SET of tracked device cloud-ids. Two instances
   * that agree produce byte-identical fingerprints; any difference in
   * membership changes it. Lets the cloud compare instances to each other and
   * to its own truth WITHOUT receiving every device on every heartbeat.
   */
  fingerprint: string
  /**
   * Up to TRACKED_SAMPLE_LIMIT tracked device cloud-ids, ascending. Enough to
   * act on a divergence without a round trip; capped so the payload stays flat.
   */
  trackedSample: number[]
  /** True when `trackedSample` is shorter than the fingerprinted set. */
  trackedSampleTruncated: boolean
  /**
   * Tracked devices with NO CloudId — locally-created rows the cloud cannot
   * join. They are counted in `trackedCount` but are absent from `fingerprint`
   * and `trackedSample`, because a cloud-id is the only thing the cloud can
   * compare on. Omitted when zero, so the steady-state payload is unaffected.
   * Present and non-zero means "my fingerprint covers less than my count".
   */
  unmappedTracked?: number
}

/**
 * One row per (subsystem, device): is its Belt Tracked cell 'Yes', and when was
 * it last written locally.
 *
 * The joins and the sheet filter are the app's canonical belt-tracking lookup
 * (app/api/vfd-commissioning/state/route.ts) reduced to the single column this
 * telemetry needs — the column name itself comes from vfd-validation-writer, so
 * the writer and this reader can never drift apart on what "tracked" means.
 *
 * `COALESCE(d.SubsystemId, sub.id)` mirrors the scoped variant in that route:
 * devices carry SubsystemId directly, and the name-matched Subsystems fallback
 * covers legacy rows a scoped pull has not re-stamped yet.
 */
const TRACKED_SELECT = `
  SELECT
    COALESCE(d.SubsystemId, sub.id) AS subsystemId,
    d.CloudId                       AS cloudId,
    cv.Value                        AS value,
    cv.UpdatedAt                    AS updatedAt
  FROM L2Devices d
  JOIN L2Sheets  s ON s.id = d.SheetId
  LEFT JOIN L2Columns    c  ON c.SheetId = d.SheetId AND c.Name = ?
  LEFT JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
  LEFT JOIN Subsystems   sub ON sub.Name = d.Subsystem
  WHERE (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
    AND COALESCE(d.SubsystemId, sub.id) IS NOT NULL
`

/**
 * Digest over a SET of cloud-ids.
 *
 * Sorted numerically and de-duplicated first, so the fingerprint depends only
 * on MEMBERSHIP — never on row order, join order, or how a given instance's
 * SQLite happened to return the rows. That is the whole point: two instances
 * holding the same tracked set must be byte-identical here, or the cloud would
 * report divergence where there is none and this telemetry would be noise.
 *
 * Truncated to FINGERPRINT_LENGTH hex chars (48 bits). This is a comparison
 * token, never a security boundary — accidental collision across the handful of
 * instances on one MCM is not a practical concern, and the bytes matter at a
 * 10-second cadence.
 *
 * The empty set gets its own literal rather than the hash of an empty string,
 * so "nothing tracked" reads unambiguously in the fleet UI.
 */
export function fingerprintOf(cloudIds: number[]): string {
  const unique = Array.from(new Set(cloudIds)).sort((a, b) => a - b)
  if (unique.length === 0) return 'empty'
  return crypto
    .createHash('sha1')
    .update(unique.join(','))
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH)
}

/**
 * Subsystem ids this instance actually serves, from the MCM registry — the same
 * source `plc.mcms[]` is built from, so the two lists always agree.
 *
 * Returns null on legacy single-PLC deployments (registry empty), meaning "no
 * scope, report every subsystem present locally" rather than "report none".
 */
function servedSubsystemIds(): Set<number> | null {
  if (!hasAnyMcm()) return null
  const ids = new Set<number>()
  for (const m of getAggregateStatus().mcms) {
    const n = Number(m.subsystemId)
    if (Number.isFinite(n)) ids.add(n)
  }
  return ids.size > 0 ? ids : null
}

/**
 * Per-subsystem belt-tracking snapshot for the heartbeat. Pure read-only.
 *
 * Throws on DB failure — callers must use `collectBeltTrackingSafe()`.
 */
export function collectBeltTracking(): BeltTrackingSubsystemSnapshot[] {
  const rows = db.prepare(TRACKED_SELECT).all(BELT_TRACKED_COLUMN_NAME) as Array<{
    subsystemId: number | null
    cloudId: number | null
    value: string | null
    updatedAt: string | null
  }>

  const scope = servedSubsystemIds()
  const acc = new Map<
    number,
    { tracked: number[]; unmapped: number; total: number; lastUpdate: string | null }
  >()

  for (const r of rows) {
    const sid = Number(r.subsystemId)
    if (!Number.isFinite(sid)) continue
    if (scope && !scope.has(sid)) continue

    let entry = acc.get(sid)
    if (!entry) {
      entry = { tracked: [], unmapped: 0, total: 0, lastUpdate: null }
      acc.set(sid, entry)
    }
    entry.total += 1

    // Only cells the mech actually stamped carry a timestamp worth reporting;
    // an untouched (NULL) cell has none.
    if (r.updatedAt && (entry.lastUpdate === null || r.updatedAt > entry.lastUpdate)) {
      entry.lastUpdate = r.updatedAt
    }

    if (r.value !== BELT_TRACKED_VALUE) continue
    // CLOUD ids, never local ones — a local id is meaningless off-box and two
    // instances would produce different fingerprints for an identical set.
    if (typeof r.cloudId === 'number' && Number.isFinite(r.cloudId)) {
      entry.tracked.push(r.cloudId)
    } else {
      entry.unmapped += 1
    }
  }

  const out: BeltTrackingSubsystemSnapshot[] = []
  for (const [subsystemId, e] of Array.from(acc.entries()).sort((a, b) => a[0] - b[0])) {
    const unique = Array.from(new Set(e.tracked)).sort((a, b) => a - b)
    const sample = unique.slice(0, TRACKED_SAMPLE_LIMIT)
    out.push({
      subsystemId,
      // Counts the unmapped rows too: the COUNT is the truth about this
      // instance's belief, even where the fingerprint cannot represent it.
      trackedCount: unique.length + e.unmapped,
      totalDevices: e.total,
      lastLocalUpdateAt: e.lastUpdate,
      fingerprint: fingerprintOf(unique),
      trackedSample: sample,
      trackedSampleTruncated: unique.length > sample.length,
      ...(e.unmapped > 0 ? { unmappedTracked: e.unmapped } : {}),
    })
  }
  return out
}

/**
 * TELEMETRY MUST NEVER BREAK SYNCING.
 *
 * A tablet whose L2 schema is old, whose sheets are missing, or whose DB is
 * momentarily locked must still deliver its heartbeat — losing test results
 * because a diagnostic query threw would be a far worse failure than the blind
 * spot this telemetry exists to close. Same contract as the other
 * `collect*Safe()` helpers in system-info.
 */
export function collectBeltTrackingSafe(): BeltTrackingSubsystemSnapshot[] | undefined {
  try {
    const snapshots = collectBeltTracking()
    // Omit the key entirely when there is nothing to say, so non-VFD tablets
    // ship a payload byte-identical to before this change.
    return snapshots.length > 0 ? snapshots : undefined
  } catch (e) {
    console.warn('[Heartbeat] belt-tracking telemetry unavailable:', (e as Error)?.message || e)
    return undefined
  }
}
