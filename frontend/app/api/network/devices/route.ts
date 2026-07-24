import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

// Single GROUP BY aggregate replaces the old N+1 (a DISTINCT scan, then a full
// per-device COUNT/SUM scan of Ios for EVERY device). Prepared once at module
// level (same pattern as app/api/l2/cell/route.ts). Response shape unchanged.
//
// NOTE: the unfiltered query aggregates ACROSS MCMs when device names collide
// (NetworkDeviceName is not unique across subsystems). That default is kept
// for compatibility; pass ?subsystemId= to scope the aggregate to one MCM.
const stmts = {
  allDevices: db.prepare(`
    SELECT NetworkDeviceName as name,
           COUNT(*) as total,
           SUM(CASE WHEN Result = ? THEN 1 ELSE 0 END) as passed,
           SUM(CASE WHEN Result = ? THEN 1 ELSE 0 END) as failed
    FROM Ios
    WHERE NetworkDeviceName IS NOT NULL
    GROUP BY NetworkDeviceName
    ORDER BY NetworkDeviceName ASC
  `),
  devicesBySubsystem: db.prepare(`
    SELECT NetworkDeviceName as name,
           COUNT(*) as total,
           SUM(CASE WHEN Result = ? THEN 1 ELSE 0 END) as passed,
           SUM(CASE WHEN Result = ? THEN 1 ELSE 0 END) as failed
    FROM Ios
    WHERE NetworkDeviceName IS NOT NULL AND SubsystemId = ?
    GROUP BY NetworkDeviceName
    ORDER BY NetworkDeviceName ASC
  `),
}

type DeviceAggRow = { name: string; total: number; passed: number; failed: number }

export async function GET(req: Request, res: Response) {
  try {
    const subsystemIdRaw = req.query.subsystemId as string | undefined
    const subsystemId = subsystemIdRaw !== undefined ? parseInt(subsystemIdRaw, 10) : undefined

    const rows = (Number.isFinite(subsystemId)
      ? stmts.devicesBySubsystem.all('Passed', 'Failed', subsystemId)
      : stmts.allDevices.all('Passed', 'Failed')) as DeviceAggRow[]

    const enriched = rows.map(r => ({
      name: r.name,
      totalTags: r.total,
      passedTags: r.passed,
      failedTags: r.failed,
      untestedTags: r.total - r.passed - r.failed,
    }))

    return res.json(enriched)
  } catch (error) {
    console.error('Failed to fetch network devices:', error)
    return res.status(500).json({ error: 'Failed to fetch network devices' })
  }
}
