import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { parseBumpBlockerCell, resolveDeviceBlocked } from '@/lib/vfd-bump-blocker'
import { listVfdAddressedStates } from '@/lib/db/repositories/vfd-addressed-sync-repository'
import { listVfdBlockerStates } from '@/lib/db/repositories/vfd-blocker-mirror-repository'

/**
 * GET /api/vfd-commissioning/state
 *
 * Returns the commissioning state for every VFD-bearing L2 device by reading
 * directly from L2CellValues — there is no longer a separate VfdCheckState
 * table. The L2 spreadsheet (which is local-DB-stored AND cloud-synced) is
 * the single source of truth for "is this VFD commissioned".
 *
 * The columns the wizard fills:
 *   - "Verify Identity"     → from Step 1 (Identity Confirm)
 *   - "Motor HP (Field)"    → from Step 2 (HP Confirm)
 *   - "VFD HP (Field)"      → from Step 2 (HP Confirm)
 *   - "Check Direction"     → from Step 3 (Bump / Direction Confirm)
 *   - "Polarity"            → from Step 3.5 (Polarity Check). Value is "Normal"
 *                             or "Inverter" — possibly with an "INITIALS DATE · "
 *                             prefix per the wizard's stamp convention.
 *   - "Belt Tracked"        → from Step 4 (Belt Tracking complete)
 *   - "Speed Set Up"        → from Step 5 (Calibrate Speed). Stored as a stamp
 *                             "INITIALS DATE · <fpm> FPM @ <rvs> RVS" so the
 *                             measured calibration pair survives without a
 *                             separate local table.
 *
 * Response shape:
 *   {
 *     states: [
 *       {
 *         deviceName: "NCP1_2_VFD",
 *         sheetName: "APF",
 *         cells: {
 *           verifyIdentity:   "ASH 9/5"        | null,
 *           motorHpField:     "5.0"           | null,
 *           vfdHpField:       "5.0"           | null,
 *           checkDirection:   "ASH 9/5"        | null,
 *           polarity:         "ASH 9/5 · Normal" | "ASH 9/5 · Inverter" | null,
 *           beltTracked:      "ASH 9/5"        | null,
 *           speedSetUp:       "ASH 9/5 · 200 FPM @ 25.30 RVS" | null,
 *           controlsVerified: "ASH"            | null,
 *         },
 *       },
 *       ...
 *     ]
 *   }
 *
 * The optional ?subsystemId=N query param is accepted for backward compatibility
 * but ignored — L2 device rows aren't keyed by IO-subsystem id, and the caller
 * (the VFD list) already filters its own device set.
 */

const COMMISSIONING_COLUMNS = [
  'Verify Identity',
  'Motor HP (Field)',
  'VFD HP (Field)',
  // "Run Verified" — written by the reworked Test Run / Verify Controls step.
  // It is the cloud's 4th readiness control (replaced "Check Direction"). Read
  // here so the wizard can durably restore its Test Run completion across
  // laptops. Tolerant of the column not yet existing (LEFT JOIN + IN-list).
  'Run Verified',
  'Check Direction',
  'Polarity',
  'Belt Tracked',
  'Speed Set Up',
  'Bump Blocker',
] as const

type CommissioningColumn = typeof COMMISSIONING_COLUMNS[number]

function columnKey(name: CommissioningColumn): keyof CellSet {
  switch (name) {
    case 'Verify Identity':    return 'verifyIdentity'
    case 'Motor HP (Field)':   return 'motorHpField'
    case 'VFD HP (Field)':     return 'vfdHpField'
    case 'Run Verified':       return 'runVerified'
    case 'Check Direction':    return 'checkDirection'
    case 'Polarity':           return 'polarity'
    case 'Belt Tracked':       return 'beltTracked'
    case 'Speed Set Up':       return 'speedSetUp'
    case 'Bump Blocker':       return 'bumpBlocker'
  }
}

interface CellSet {
  verifyIdentity:      string | null
  motorHpField:        string | null
  vfdHpField:          string | null
  // Test Run / Verify Controls step. Cloud's 4th readiness control (replaced
  // "Check Direction"). Tolerant of the column not existing yet on a sheet.
  runVerified:         string | null
  checkDirection:      string | null
  polarity:            string | null
  beltTracked:         string | null
  speedSetUp:          string | null
  controlsVerified:    string | null
  // Step 3 "Bump didn't work?" blocker. Tolerant of the column not existing on
  // a sheet yet (LEFT JOIN + IN-list below) — stays null until cloud provisions
  // the column, exactly like Polarity did before its rollout.
  bumpBlocker:         string | null
}

const emptyCells = (): CellSet => ({
  verifyIdentity: null, motorHpField: null, vfdHpField: null,
  runVerified: null,
  checkDirection: null, polarity: null, beltTracked: null, speedSetUp: null,
  controlsVerified: null, bumpBlocker: null,
})

// One bulk query: for every L2 device on a VFD/APF sheet, give me each of the
// commissioning column values (NULL if the cell hasn't been written, or if
// the column itself doesn't exist yet on this sheet — `Polarity` only exists
// once cloud has been updated, but the LEFT JOIN tolerates its absence).
const stmtAllCells = db.prepare(`
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
  WHERE c.Name IN ('Verify Identity', 'Motor HP (Field)', 'VFD HP (Field)', 'Run Verified', 'Check Direction', 'Polarity', 'Belt Tracked', 'Speed Set Up', 'Bump Blocker')
    AND (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
`)

// Step 4 "Controls Verified" is stored locally (no L2 column).
const stmtControlsVerified = db.prepare(
  `SELECT deviceName, completedBy, completedAt FROM VfdControlsVerified`
)

export async function GET(_req: Request, res: Response) {
  try {
    const rows = stmtAllCells.all() as Array<{
      deviceId: number
      deviceName: string
      mcm: string | null
      subsystem: string | null
      deviceSubsystemId: number | null
      sheetName: string
      resolvedSubsystemId: number | null
      columnName: CommissioningColumn
      value: string | null
    }>

    // Load all controls-verified stamps (local-only, keyed by deviceName)
    const cvRows = stmtControlsVerified.all() as Array<{
      deviceName: string; completedBy: string | null; completedAt: string | null
    }>
    const cvMap = new Map(cvRows.map(r => [r.deviceName, r.completedBy || r.completedAt || 'yes']))

    // Cloud-authoritative ADDRESSED mirror (read-only on the field tool), keyed
    // by (subsystemId, deviceName) — the same key the cloud resolves on.
    const addressedStates = listVfdAddressedStates()
    const addressedMap = new Map(
      addressedStates.map(a => [`${a.subsystemId}::${a.deviceName}`, a]),
    )

    // Cloud-authoritative BLOCKER mirror (read-only on the field tool), keyed by
    // (subsystemId, deviceName). A blocker raised on ANOTHER box lives here, not
    // in this box's Bump Blocker cell — so without this merge a belt blocked
    // elsewhere reads as "ready" locally (the MCM15 divergence). The local cell
    // wins when present; and a device with an IN-FLIGHT local op (below) is
    // local-authoritative even when its cell is now empty (a just-cleared
    // blocker), so the mirror can't resurrect it in the window before the next
    // pull prunes the stale row (resolveDeviceBlocked).
    const blockerStates = listVfdBlockerStates()
    const blockerMap = new Map(
      blockerStates.map(b => [`${b.subsystemId}::${b.deviceName}`, b]),
    )

    // In-flight local blocker ops (a set/clear the tech just made on THIS box,
    // still queued in DeviceBlockerPendingSyncs — parked rows included, unresolved
    // intent). For these devices the LOCAL cell is authoritative: the cloud
    // mirror must not override a just-cleared blocker until the next pull prunes
    // it (the stale-mirror window). Keyed subsystemId::deviceName (lower-cased),
    // matching the mirror's pending-guard.
    const pendingBlockerKeys = new Set(
      (db.prepare('SELECT SubsystemId, DeviceName FROM DeviceBlockerPendingSyncs').all() as Array<{ SubsystemId: number; DeviceName: string }>)
        .map(r => `${r.SubsystemId}::${String(r.DeviceName).trim().toLowerCase()}`),
    )

    // Pivot rows → one record per (deviceName, sheetName) with a CellSet + meta
    type Acc = {
      deviceId: number
      deviceName: string
      mcm: string | null
      subsystem: string | null
      sheetName: string
      subsystemId: number
      cells: CellSet
    }
    const byKey = new Map<string, Acc>()
    for (const row of rows) {
      const key = `${row.deviceName}::${row.sheetName}`
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
      const colKey = columnKey(row.columnName)
      if (colKey) acc.cells[colKey] = row.value
    }

    // Merge controls-verified into each device's cell set
    for (const acc of byKey.values()) {
      const cv = cvMap.get(acc.deviceName)
      if (cv) acc.cells.controlsVerified = cv
    }

    // Build the response: cells + device meta + blocked/addressed annotations so
    // the VFD Commissioning view can render the BLOCKED + (read-only) ADDRESSED
    // columns and self-load its device list without a separate fetch.
    const states = Array.from(byKey.values()).map(acc => {
      const annotationKey = `${acc.subsystemId}::${acc.deviceName}`
      // Local Bump Blocker cell wins (a blocker raised/cleared on THIS box);
      // otherwise fall back to the cloud mirror (a blocker raised on another box).
      const cellBlocker = parseBumpBlockerCell(acc.cells.bumpBlocker)
      const mirrored = blockerMap.get(annotationKey)
      const hasPendingBlockerOp = pendingBlockerKeys.has(
        `${acc.subsystemId}::${acc.deviceName.trim().toLowerCase()}`,
      )
      const blocker = resolveDeviceBlocked(cellBlocker, mirrored, hasPendingBlockerOp)
      const blocked = blocker !== null
      const local = addressedMap.get(annotationKey)
      return {
        deviceId: acc.deviceId,
        deviceName: acc.deviceName,
        mcm: acc.mcm,
        subsystem: acc.subsystem,
        sheetName: acc.sheetName,
        subsystemId: acc.subsystemId,
        cells: acc.cells,
        // Blocked state + parsed blocker party/reason from the Bump Blocker cell.
        blocked,
        blockerParty: blocker?.party ?? null,
        blockerReason: blocker?.description ?? null,
        // ADDRESSED is an annotation only meaningful while blocked.
        addressed: blocked ? Boolean(local?.addressed) : false,
        addressedBy: blocked ? local?.addressedBy ?? null : null,
        addressedAt: blocked ? local?.addressedAt ?? null : null,
      }
    })

    return res.json({ states })
  } catch (error) {
    console.error('[VFD State GET] Error:', error)
    return res.status(500).json({ error: `Failed to fetch VFD commissioning state: ${error instanceof Error ? error.message : error}` })
  }
}

/**
 * POST /api/vfd-commissioning/state
 *
 * Deprecated. The wizard now writes only to L2 (via /write-l2-cells) and the
 * PLC. We keep this route returning a JSON 410 so any old client code that
 * still POSTs here gets a clean error instead of an HTML 404 page.
 */
export async function POST(_req: Request, res: Response) {
  return res.status(410).json({
    error: 'Deprecated: VFD commissioning state is now stored entirely in L2 cells. Use /api/vfd-commissioning/write-l2-cells.',
  })
}
