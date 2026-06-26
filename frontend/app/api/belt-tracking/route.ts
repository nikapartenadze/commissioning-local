import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { parseBumpBlockerCell } from '@/lib/vfd-bump-blocker'
import { listVfdAddressedStates } from '@/lib/db/repositories/vfd-addressed-sync-repository'

/**
 * GET /api/belt-tracking
 *
 * Field-tool mirror of the cloud /belt-tracking page, reading LOCAL SQLite only
 * (works offline). Returns one row per belt VFD on a VFD/APF L2 sheet with the
 * four control cell values, the Belt Tracked cell, and the Bump Blocker cell —
 * plus the derived status flags the UI needs.
 *
 * Status derivation mirrors the cloud (lib/belt-tracking/derive-status.ts):
 *   - blocked  = the "Bump Blocker" cell parses to a real blocker (non-empty)
 *   - ready    = all four control cells are filled
 *                ("Verify Identity", "Motor HP (Field)", "VFD HP (Field)",
 *                 "Check Direction")
 *   - tracked  = "Belt Tracked" === "Yes"
 *   - status   = tracked ? Tracked : blocked ? Blocked : ready ? Ready : Not Ready
 *
 * subsystemId per row is resolved with a fallback chain so the ADDRESSED push
 * (POST /api/belt-tracking/addressed) can identify the device to the cloud:
 *   1. L2Devices.SubsystemId (set by per-MCM pull-l2)
 *   2. Subsystems.id matched by name to L2Devices.Subsystem
 * It may be 0 when neither resolves (legacy single-MCM full pull with no
 * matching subsystem row); the UI then disables ADDRESSED for that belt.
 */

// Mirror of the cloud canonical column names (lib/belt-tracking/types.ts).
const VERIFY_IDENTITY = 'Verify Identity'
const MOTOR_HP_FIELD = 'Motor HP (Field)'
const VFD_HP_FIELD = 'VFD HP (Field)'
const CHECK_DIRECTION = 'Check Direction'
const BELT_TRACKED = 'Belt Tracked'
const BUMP_BLOCKER = 'Bump Blocker'
const BELT_TRACKED_VALUE = 'Yes'

/**
 * Columns the VFD wizard WRITES (write-l2-cells / bump-blocker paths). If any
 * is absent from a sheet's L2 template, the wizard's write to it is silently
 * DROPPED at app/api/vfd-commissioning/write-l2-cells/route.ts (the cells exist
 * with no durable L2 record — the CDW5 polarity incident, 3 weeks of rework).
 * Phase 3 launch guard (c) blocks wizard entry until "pull latest L2" restores
 * these, so no PLC bit is written without a durable home.
 */
const REQUIRED_WIZARD_COLUMNS = [
  VERIFY_IDENTITY,
  MOTOR_HP_FIELD,
  VFD_HP_FIELD,
  CHECK_DIRECTION,
  BUMP_BLOCKER,
  'Polarity',
  'Speed Set Up',
] as const

const READ_COLUMNS = [
  VERIFY_IDENTITY,
  MOTOR_HP_FIELD,
  VFD_HP_FIELD,
  CHECK_DIRECTION,
  BELT_TRACKED,
  BUMP_BLOCKER,
] as const

type ReadColumn = (typeof READ_COLUMNS)[number]

interface Cells {
  verifyIdentity: string | null
  motorHpField: string | null
  vfdHpField: string | null
  checkDirection: string | null
  beltTracked: string | null
  bumpBlocker: string | null
}

const emptyCells = (): Cells => ({
  verifyIdentity: null,
  motorHpField: null,
  vfdHpField: null,
  checkDirection: null,
  beltTracked: null,
  bumpBlocker: null,
})

function assign(cells: Cells, column: ReadColumn, value: string | null): void {
  switch (column) {
    case VERIFY_IDENTITY: cells.verifyIdentity = value; break
    case MOTOR_HP_FIELD: cells.motorHpField = value; break
    case VFD_HP_FIELD: cells.vfdHpField = value; break
    case CHECK_DIRECTION: cells.checkDirection = value; break
    case BELT_TRACKED: cells.beltTracked = value; break
    case BUMP_BLOCKER: cells.bumpBlocker = value; break
  }
}

function isNonEmpty(v: string | null): boolean {
  return v != null && v.trim() !== ''
}

// One bulk query over every L2 device on a VFD/APF sheet. LEFT JOIN tolerates a
// column not existing on a sheet yet (e.g. Bump Blocker before cloud provisions
// it), exactly like the existing vfd-commissioning/state route.
const stmtCells = db.prepare(`
  SELECT
    d.id            AS deviceId,
    d.DeviceName    AS deviceName,
    d.Mcm           AS mcm,
    d.Subsystem     AS subsystem,
    d.SubsystemId   AS deviceSubsystemId,
    s.Name          AS sheetName,
    sub.id          AS resolvedSubsystemId,
    c.Name          AS columnName,
    cv.Value        AS value
  FROM L2Devices d
  JOIN L2Sheets   s ON s.id = d.SheetId
  JOIN L2Columns  c ON c.SheetId = d.SheetId
  LEFT JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
  LEFT JOIN Subsystems   sub ON sub.Name = d.Subsystem
  WHERE c.Name IN ('Verify Identity', 'Motor HP (Field)', 'VFD HP (Field)', 'Check Direction', 'Belt Tracked', 'Bump Blocker')
    AND (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
`)

// Which of the wizard-written columns exist on each VFD/APF sheet. Used to
// derive per-row `missingColumns` so the page can block wizard launch with a
// "pull latest L2" guard when a write target is absent (Phase 3 guard c).
const stmtSheetColumns = db.prepare(`
  SELECT s.id AS sheetId, c.Name AS columnName
  FROM L2Sheets s
  JOIN L2Columns c ON c.SheetId = s.id
  WHERE (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
    AND c.Name IN ('Verify Identity', 'Motor HP (Field)', 'VFD HP (Field)', 'Check Direction', 'Bump Blocker', 'Polarity', 'Speed Set Up')
`)

export async function GET(_req: Request, res: Response) {
  try {
    const rows = stmtCells.all() as Array<{
      deviceId: number
      deviceName: string
      mcm: string | null
      subsystem: string | null
      deviceSubsystemId: number | null
      sheetName: string
      resolvedSubsystemId: number | null
      columnName: ReadColumn
      value: string | null
    }>

    // Resolve which wizard-write columns exist, keyed by sheetName (belts carry
    // sheetName, not sheetId). Union across sheets sharing a name — a column
    // present on any same-named sheet counts as present.
    const colRows = stmtSheetColumns.all() as Array<{ sheetId: number; columnName: string }>
    const idNameRows = db
      .prepare(`SELECT id, Name FROM L2Sheets WHERE UPPER(Name) LIKE '%VFD%' OR UPPER(Name) LIKE '%APF%'`)
      .all() as Array<{ id: number; Name: string }>
    const sheetNameById = new Map<number, string>(idNameRows.map(r => [r.id, r.Name]))
    const presentBySheetName = new Map<string, Set<string>>()
    for (const cr of colRows) {
      const name = sheetNameById.get(cr.sheetId)
      if (!name) continue
      let set = presentBySheetName.get(name)
      if (!set) { set = new Set(); presentBySheetName.set(name, set) }
      set.add(cr.columnName)
    }

    type Acc = {
      deviceId: number
      deviceName: string
      mcm: string | null
      subsystem: string | null
      sheetName: string
      subsystemId: number
      cells: Cells
    }

    const byKey = new Map<string, Acc>()
    for (const row of rows) {
      const key = `${row.deviceId}`
      let acc = byKey.get(key)
      if (!acc) {
        acc = {
          deviceId: row.deviceId,
          deviceName: row.deviceName,
          mcm: row.mcm,
          subsystem: row.subsystem,
          sheetName: row.sheetName,
          // Fallback chain: explicit per-MCM id → name-matched subsystem → 0.
          subsystemId: row.deviceSubsystemId ?? row.resolvedSubsystemId ?? 0,
          cells: emptyCells(),
        }
        byKey.set(key, acc)
      }
      assign(acc.cells, row.columnName, row.value)
    }

    // Local ADDRESSED state, keyed by (subsystemId, deviceName).
    const addressedStates = listVfdAddressedStates()
    const addressedMap = new Map(
      addressedStates.map(a => [`${a.subsystemId}::${a.deviceName}`, a]),
    )

    const belts = Array.from(byKey.values()).map(acc => {
      const blocker = parseBumpBlockerCell(acc.cells.bumpBlocker)
      const blocked = blocker !== null
      const ready =
        isNonEmpty(acc.cells.verifyIdentity) &&
        isNonEmpty(acc.cells.motorHpField) &&
        isNonEmpty(acc.cells.vfdHpField) &&
        isNonEmpty(acc.cells.checkDirection)
      const tracked = (acc.cells.beltTracked ?? '').trim() === BELT_TRACKED_VALUE

      const status = tracked ? 'Tracked' : blocked ? 'Blocked' : ready ? 'Ready' : 'Not Ready'

      const local = addressedMap.get(`${acc.subsystemId}::${acc.deviceName}`)

      // Wizard-launch durability guard (Phase 3 guard c): any required
      // wizard-write column missing from this belt's sheet means the page must
      // block launch and prompt "pull latest L2".
      const present = presentBySheetName.get(acc.sheetName) ?? new Set<string>()
      const missingColumns = REQUIRED_WIZARD_COLUMNS.filter(c => !present.has(c))

      return {
        deviceId: acc.deviceId,
        deviceName: acc.deviceName,
        mcm: acc.mcm,
        subsystem: acc.subsystem,
        sheetName: acc.sheetName,
        subsystemId: acc.subsystemId,
        cells: {
          verifyIdentity: acc.cells.verifyIdentity,
          motorHpField: acc.cells.motorHpField,
          vfdHpField: acc.cells.vfdHpField,
          checkDirection: acc.cells.checkDirection,
          beltTracked: acc.cells.beltTracked,
        },
        blocked,
        ready,
        tracked,
        status,
        // Blocker party + reason, parsed from the Bump Blocker cell.
        blockerParty: blocker?.party ?? null,
        blockerReason: blocker?.description ?? null,
        // ADDRESSED is an annotation only meaningful while blocked.
        addressed: blocked ? Boolean(local?.addressed) : false,
        addressedBy: blocked ? local?.addressedBy ?? null : null,
        addressedAt: blocked ? local?.addressedAt ?? null : null,
        // Wizard-launch durability guard: empty ⇒ safe to launch.
        missingColumns,
      }
    })

    // Surface actionable rows first: Ready, Blocked, Tracked, Not Ready.
    const rank = (s: string) =>
      s === 'Ready' ? 0 : s === 'Blocked' ? 1 : s === 'Tracked' ? 2 : 3
    belts.sort((a, b) => rank(a.status) - rank(b.status) || a.deviceName.localeCompare(b.deviceName))

    return res.json({ belts })
  } catch (error) {
    console.error('[BeltTracking GET] Error:', error)
    return res.status(500).json({
      error: `Failed to fetch belt tracking: ${error instanceof Error ? error.message : error}`,
    })
  }
}
