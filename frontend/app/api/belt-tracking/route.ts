import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { mapToVfdRows, type RawVfdJoinRow } from '@/lib/belt-tracking/mappers'
import type { BeltTrackingResponse, BeltTrackingError } from '@/lib/belt-tracking/types'

/**
 * GET /api/belt-tracking
 *
 * Read endpoint backing the mechanics-only belt-tracking page.
 *
 * Returns ALL VFDs in the local L2 database — across every MCM and
 * subsystem the cloud has pulled down. Functional validation runs at
 * project scope (one mechanic spans many subsystems), unlike IO
 * testing which is per-subsystem. Filtering by MCM / subsystem
 * happens client-side via the page's filter popovers.
 *
 * "Ready for Tracking" is derived from the four controls-verified
 * L2 cells (Verify Identity, Motor HP Field, VFD HP Field, Check
 * Direction). All four are cloud-synced, so this signal is
 * consistent across field servers.
 */

const CONTROLS_COLUMN_NAMES = [
  'Verify Identity',
  'Motor HP (Field)',
  'VFD HP (Field)',
  'Check Direction',
]

const stmts = {
  getVfdSheetId: db.prepare(`SELECT id FROM L2Sheets WHERE Name = 'VFD' LIMIT 1`),
  getColumnIdByName: db.prepare(`
    SELECT id FROM L2Columns WHERE SheetId = ? AND Name = ? LIMIT 1
  `),
}

interface ResolvedColumns {
  beltTracked: number
  verify: number
  motorHp: number
  vfdHp: number
  direction: number
}

/**
 * Build the joined query. We resolve column IDs at request time and
 * splice them into the prepared statement; better-sqlite3 caches
 * compiled statements per SQL string, so this is cheap on repeat hits.
 *
 * No subsystem WHERE clause — the belt-tracking page is project-scoped,
 * unlike IO testing. Filtering happens client-side.
 */
function buildVfdRowsQuery(cols: ResolvedColumns) {
  const sql = `
    SELECT
      d.id           AS deviceId,
      d.DeviceName   AS deviceName,
      d.Mcm          AS mcm,
      d.Subsystem    AS subsystem,

      bt.Value       AS trackedValue,
      bt.UpdatedBy   AS trackedBy,
      bt.UpdatedAt   AS trackedAt,
      bt.Version     AS trackedVersion,

      vi.Value       AS verifyValue,
      vi.UpdatedAt   AS verifyAt,
      vi.UpdatedBy   AS verifyBy,

      mhp.Value      AS motorHpValue,
      mhp.UpdatedAt  AS motorHpAt,
      mhp.UpdatedBy  AS motorHpBy,

      vhp.Value      AS vfdHpValue,
      vhp.UpdatedAt  AS vfdHpAt,
      vhp.UpdatedBy  AS vfdHpBy,

      cd.Value       AS directionValue,
      cd.UpdatedAt   AS directionAt,
      cd.UpdatedBy   AS directionBy
    FROM L2Devices d
    LEFT JOIN L2CellValues bt  ON bt.DeviceId  = d.id AND bt.ColumnId  = ${cols.beltTracked}
    LEFT JOIN L2CellValues vi  ON vi.DeviceId  = d.id AND vi.ColumnId  = ${cols.verify}
    LEFT JOIN L2CellValues mhp ON mhp.DeviceId = d.id AND mhp.ColumnId = ${cols.motorHp}
    LEFT JOIN L2CellValues vhp ON vhp.DeviceId = d.id AND vhp.ColumnId = ${cols.vfdHp}
    LEFT JOIN L2CellValues cd  ON cd.DeviceId  = d.id AND cd.ColumnId  = ${cols.direction}
    WHERE d.SheetId = ?
    ORDER BY d.Mcm ASC, d.DisplayOrder ASC, d.DeviceName ASC
  `
  return db.prepare(sql)
}

export async function GET(_req: Request, res: Response) {
  try {
    const vfdSheet = stmts.getVfdSheetId.get() as { id: number } | undefined
    if (!vfdSheet) {
      return res.status(404).json({
        error: 'VFD sheet not present in this server\'s L2 schema',
        code: 'no_belt_column',
      } satisfies BeltTrackingError)
    }

    // Resolve all needed column ids by name
    const lookup = (name: string): number | null => {
      const row = stmts.getColumnIdByName.get(vfdSheet.id, name) as { id: number } | undefined
      return row?.id ?? null
    }
    const beltTracked = lookup('Belt Tracked')
    const verify      = lookup('Verify Identity')
    const motorHp     = lookup('Motor HP (Field)')
    const vfdHp       = lookup('VFD HP (Field)')
    const direction   = lookup('Check Direction')

    if (!beltTracked || !verify || !motorHp || !vfdHp || !direction) {
      const missing = [
        !beltTracked && 'Belt Tracked',
        !verify && 'Verify Identity',
        !motorHp && 'Motor HP (Field)',
        !vfdHp && 'VFD HP (Field)',
        !direction && 'Check Direction',
      ].filter(Boolean).join(', ')
      return res.status(404).json({
        error: `Missing required L2 columns: ${missing}`,
        code: 'no_belt_column',
      } satisfies BeltTrackingError)
    }

    const stmt = buildVfdRowsQuery({ beltTracked, verify, motorHp, vfdHp, direction })
    const rawRows = stmt.all(vfdSheet.id) as RawVfdJoinRow[]
    const vfds = mapToVfdRows(rawRows)

    return res.json({
      beltTrackedColumnId: beltTracked,
      vfds,
    } satisfies BeltTrackingResponse)
  } catch (err) {
    console.error('[belt-tracking] error:', err)
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Unknown error',
      code: 'unknown',
    } satisfies BeltTrackingError)
  }
}
