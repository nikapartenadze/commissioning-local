import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

/**
 * GET /api/cloud/sync-l2/items
 *
 * Returns every row in L2PendingSyncs joined with device/column/sheet
 * metadata so the CloudSyncDialog can show operators what's actually
 * waiting in the queue, rather than just a count. Each row also carries
 * the current local cell value/version so the operator can see whether
 * the pending push reflects current local state.
 *
 * Designed for human display only — no auth needed beyond the existing
 * route middleware. Capped to 500 rows; the queue should never realistically
 * grow that large.
 */
export async function GET(_req: Request, res: Response) {
  try {
    const rows = db.prepare(`
      SELECT
        ps.id            AS id,
        ps.CloudDeviceId AS cloudDeviceId,
        ps.CloudColumnId AS cloudColumnId,
        ps.Value         AS pendingValue,
        ps.Version       AS baseVersion,
        ps.UpdatedBy     AS updatedBy,
        ps.RetryCount    AS retryCount,
        ps.LastError     AS lastError,
        ps.CreatedAt     AS createdAt,
        d.id             AS localDeviceId,
        d.DeviceName     AS deviceName,
        d.Mcm            AS mcm,
        c.id             AS localColumnId,
        c.Name           AS columnName,
        s.Name           AS sheetName,
        s.DisplayName    AS sheetDisplayName,
        cv.Value         AS localValue,
        cv.Version       AS localVersion,
        cv.UpdatedAt     AS localUpdatedAt
      FROM L2PendingSyncs ps
      LEFT JOIN L2Devices  d  ON d.CloudId = ps.CloudDeviceId
      LEFT JOIN L2Columns  c  ON c.CloudId = ps.CloudColumnId
      LEFT JOIN L2Sheets   s  ON s.id      = d.SheetId
      LEFT JOIN L2CellValues cv ON cv.DeviceId = d.id AND cv.ColumnId = c.id
      ORDER BY ps.CreatedAt ASC
      LIMIT 500
    `).all() as Array<Record<string, unknown>>

    return res.json({ count: rows.length, items: rows })
  } catch (error) {
    console.error('[L2 SyncItems] Error listing pending rows:', error)
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list pending L2 syncs',
    })
  }
}
