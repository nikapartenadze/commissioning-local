/**
 * Resolve a device's belt-tracking state from the LOCAL L2 cell.
 *
 * Split out of belt-tracking-gate.ts because this file prepares SQLite
 * statements at module load and therefore cannot be unit-tested; the decision
 * itself is pure and lives next door. (Same split as
 * lib/vfd-clear-sequence.ts vs app/api/vfd-commissioning/clear/route.ts.)
 *
 * The joins and the sheet filter are the app's canonical belt-tracking lookup,
 * lifted from app/api/vfd-commissioning/state/route.ts (ALL_CELLS_SELECT and
 * its scoped variant) and narrowed to the one column this gate needs. The
 * column NAME comes from vfd-validation-writer, so the writer, the telemetry
 * and this gate cannot drift apart on what "tracked" means.
 *
 * WHAT COUNTS AS TRACKED
 * ----------------------
 * A NON-EMPTY cell. This matches the wizard's own gate
 * (lib/vfd-wizard-gate.ts `filled()`), which is what the operator sees, and
 * the task statement ("refused when the cell is empty"). It is deliberately
 * looser than vfd-validation-writer's `= 'Yes'` sweep predicate: a server
 * backstop that refused writes the UI legitimately offers would be a support
 * ticket, not a safety win. Anything the writer considers tracked, this
 * considers tracked too.
 */
import { db } from '@/lib/db-sqlite'
import { BELT_TRACKED_COLUMN_NAME } from '@/lib/vfd-validation-writer'
import type { BeltTrackedState } from './belt-tracking-gate'

interface Row {
  deviceSubsystemId: number | null
  hasColumn: number
  tracked: number
}

const BASE_SELECT = `
  SELECT
    d.SubsystemId AS deviceSubsystemId,
    MAX(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END)                  AS hasColumn,
    MAX(CASE WHEN TRIM(COALESCE(cv.Value, '')) <> '' THEN 1 ELSE 0 END) AS tracked
  FROM L2Devices d
  JOIN L2Sheets  s ON s.id = d.SheetId
  LEFT JOIN L2Columns    c  ON c.SheetId = d.SheetId AND c.Name = ?
  LEFT JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
  LEFT JOIN Subsystems   sub ON sub.Name = d.Subsystem
  WHERE LOWER(d.DeviceName) = LOWER(?)
    AND (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
`

const stmtAll = db.prepare(`${BASE_SELECT} GROUP BY d.id`)
// Scoped variant, mirroring state/route.ts: devices carry SubsystemId directly;
// the name-matched Subsystems fallback covers legacy rows a scoped pull has not
// re-stamped yet, so scoping never blanks a device that used to resolve.
const stmtScoped = db.prepare(
  `${BASE_SELECT} AND (d.SubsystemId = ? OR (d.SubsystemId IS NULL AND sub.id = ?)) GROUP BY d.id`,
)

/**
 * Belt-tracking state for `deviceName`, optionally scoped to one MCM.
 *
 * MULTI-MCM FOLD. Belt names repeat across MCMs. When the caller sends a
 * subsystemId (the wizard always does) the query is scoped and there is one
 * row. When it does not, several rows can come back for genuinely different
 * belts, and the fold is conservative:
 *
 *   hasColumn = ANY row has the column   (the gate applies if it applies anywhere)
 *   tracked   = EVERY row with the column is tracked
 *
 * An unscoped caller cannot prove which belt it is about to move, so it does
 * not get the benefit of the doubt. A legacy single-MCM tablet has exactly one
 * row and is unaffected.
 *
 * Never throws: a failure comes back as `{ resolved: false, error }`, which
 * judgeWrite treats as "cannot prove tracked" and REFUSES post-gate fields on.
 */
export function lookupBeltTrackedState(
  deviceName: string,
  subsystemId?: string | number | null,
): BeltTrackedState {
  try {
    const sid = subsystemId == null || subsystemId === '' ? NaN : Number(subsystemId)
    const scoped = Number.isFinite(sid) && sid > 0

    const rows = (scoped
      ? stmtScoped.all(BELT_TRACKED_COLUMN_NAME, deviceName, sid, sid)
      : stmtAll.all(BELT_TRACKED_COLUMN_NAME, deviceName)) as Row[]

    if (rows.length === 0) return { resolved: false }

    const withColumn = rows.filter(r => r.hasColumn === 1)
    if (withColumn.length === 0) return { resolved: true, hasColumn: false }

    return {
      resolved: true,
      hasColumn: true,
      tracked: withColumn.every(r => r.tracked === 1),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[VFD Gate] Belt-tracked lookup failed for "${deviceName}":`, message)
    return { resolved: false, error: 'belt-tracking lookup failed' }
  }
}
