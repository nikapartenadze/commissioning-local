import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * GET /api/vfd-commissioning/state
 *
 * Returns the commissioning state for every VFD-bearing L2 device by reading
 * directly from L2CellValues — there is no longer a separate VfdCheckState
 * table. The L2 spreadsheet (which is local-DB-stored AND cloud-synced) is
 * the single source of truth for "is this VFD commissioned".
 *
 * The six columns the wizard fills:
 *   - "Verify Identity"     → from Step 1 (Identity Confirm)
 *   - "Motor HP (Field)"    → from Step 2 (HP Confirm)
 *   - "VFD HP (Field)"      → from Step 2 (HP Confirm)
 *   - "Check Direction"     → from Step 3 (Bump / Direction Confirm)
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
 *           beltTracked:      "ASH 9/5"        | null,
 *           speedSetUp:       "ASH 9/5 · 200 FPM @ 25.30 RVS" | null,
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
  'Check Direction',
  'Belt Tracked',
  'Speed Set Up',
] as const

type CommissioningColumn = typeof COMMISSIONING_COLUMNS[number]

function columnKey(name: CommissioningColumn): keyof CellSet {
  switch (name) {
    case 'Verify Identity':    return 'verifyIdentity'
    case 'Motor HP (Field)':   return 'motorHpField'
    case 'VFD HP (Field)':     return 'vfdHpField'
    case 'Check Direction':    return 'checkDirection'
    case 'Belt Tracked':       return 'beltTracked'
    case 'Speed Set Up':       return 'speedSetUp'
  }
}

interface CellSet {
  verifyIdentity:      string | null
  motorHpField:        string | null
  vfdHpField:          string | null
  checkDirection:      string | null
  beltTracked:         string | null
  speedSetUp:          string | null
  controlsVerified:    string | null
}

const emptyCells = (): CellSet => ({
  verifyIdentity: null, motorHpField: null, vfdHpField: null,
  checkDirection: null, beltTracked: null, speedSetUp: null,
  controlsVerified: null,
})

// One bulk query: for every L2 device on a VFD/APF sheet, give me each of the
// 6 commissioning column values (NULL if the cell hasn't been written).
const stmtAllCells = db.prepare(`
  SELECT
    d.DeviceName    AS deviceName,
    s.Name          AS sheetName,
    c.Name          AS columnName,
    cv.Value        AS value
  FROM L2Devices d
  JOIN L2Sheets   s ON s.id = d.SheetId
  JOIN L2Columns  c ON c.SheetId = d.SheetId
  LEFT JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
  WHERE c.Name IN ('Verify Identity', 'Motor HP (Field)', 'VFD HP (Field)', 'Check Direction', 'Belt Tracked', 'Speed Set Up')
    AND (UPPER(s.Name) LIKE '%VFD%' OR UPPER(s.Name) LIKE '%APF%')
`)

// Step 4 "Controls Verified" is stored locally (no L2 column).
const stmtControlsVerified = db.prepare(
  `SELECT deviceName, completedBy, completedAt FROM VfdControlsVerified`
)

export async function GET(_req: Request, res: Response) {
  try {
    const rows = stmtAllCells.all() as Array<{
      deviceName: string
      sheetName: string
      columnName: CommissioningColumn
      value: string | null
    }>

    // Load all controls-verified stamps (local-only, keyed by deviceName)
    const cvRows = stmtControlsVerified.all() as Array<{
      deviceName: string; completedBy: string | null; completedAt: string | null
    }>
    const cvMap = new Map(cvRows.map(r => [r.deviceName, r.completedBy || r.completedAt || 'yes']))

    // Pivot rows → one record per (deviceName, sheetName) with a CellSet
    type Acc = { deviceName: string; sheetName: string; cells: CellSet }
    const byKey = new Map<string, Acc>()
    for (const row of rows) {
      const key = `${row.deviceName}::${row.sheetName}`
      let acc = byKey.get(key)
      if (!acc) {
        acc = { deviceName: row.deviceName, sheetName: row.sheetName, cells: emptyCells() }
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

    return res.json({ states: Array.from(byKey.values()) })
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
