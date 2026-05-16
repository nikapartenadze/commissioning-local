import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import type { IoSummary } from '@/lib/guided/types'

interface IoRow {
  id: number
  Name: string
  Description: string | null
  Result: string | null
  Comments: string | null
  InstallationStatus: string | null
  InstallationPercent: number | null
}

/**
 * GET /api/guided/devices/:name?subsystemId=...
 *
 * Returns the IOs belonging to a single device, with their current Result
 * values for display in the drawer. Read-only — no writes happen here.
 */
export async function GET(req: Request, res: Response) {
  const subsystemIdRaw = req.query.subsystemId
  const subsystemId = typeof subsystemIdRaw === 'string'
    ? parseInt(subsystemIdRaw, 10)
    : NaN
  if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ error: 'Valid subsystemId query param is required' })
  }

  const deviceName = req.params.name
  if (!deviceName) {
    return res.status(400).json({ error: 'Device name is required' })
  }

  // Resolve the device's IOs via four overlapping rules — see
  // /api/guided/devices for the full reasoning. Single SQL query keeps
  // the per-click latency low.
  //
  //   1) NetworkDeviceName = ?              (VFD / FIOM)
  //   2) NetworkDeviceName = ? || '_PD'     (laser photoeye alias)
  //   3) Description LIKE '? %'             (physical-device IOs whose
  //                                          identity lives in the
  //                                          Description column —
  //                                          photoeyes, beacons, EPCs)
  //   4) Description LIKE '?_%'             (component sub-IOs, e.g.
  //                                          beacon's _A amber and _H
  //                                          horn lines)
  // SPAREs are hidden in Guided mode (matches the regular IO grid at
  // enhanced-io-data-grid.tsx:526-527). They cannot be passed or failed
  // from here — the path for spares is "Skip" in the value-change dialog.
  const rows = db.prepare(`
    SELECT id, Name, Description, Result, Comments,
           InstallationStatus, InstallationPercent
      FROM Ios
     WHERE SubsystemId = @sub
       AND (
            NetworkDeviceName = @name
         OR NetworkDeviceName = @namePd
         OR Description LIKE @descSpace
         OR Description LIKE @descUnder
       )
       AND (Description IS NULL OR UPPER(Description) NOT LIKE '%SPARE%')
     ORDER BY "Order", id
  `).all({
    sub: subsystemId,
    name: deviceName,
    namePd: deviceName + '_PD',
    descSpace: deviceName + ' %',
    descUnder: deviceName + '_%',
  }) as IoRow[]

  const ios: IoSummary[] = rows.map(r => ({
    id: r.id,
    name: r.Name,
    description: r.Description,
    result: r.Result === 'Passed' || r.Result === 'Failed' ? r.Result as 'Passed' | 'Failed' : null,
    comments: r.Comments,
    ioDirection: null, // Phase 2: classify from name pattern using existing helper
    installationStatus: r.InstallationStatus,
    installationPercent: r.InstallationPercent,
  }))

  return res.json({ deviceName, ios })
}
