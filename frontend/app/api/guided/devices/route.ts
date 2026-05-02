import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { parseDeviceIdsFromSvg } from '@/lib/guided/svg-parser'
import { computeDeviceState } from '@/lib/guided/device-state'
import { readBundledSvg } from '@/app/api/maps/subsystem/[id]/route'
import type { Device } from '@/lib/guided/types'

interface IoCountRow {
  deviceName: string
  total: number
  passed: number
  failed: number
}

/**
 * GET /api/guided/devices?subsystemId=...&skipped=A,B,C
 *
 * Returns the list of devices that appear in the bundled SVG, in document
 * order, joined to live IO counts from the local Ios table. Each device
 * is stamped with its computed state (untested / in_progress / passed /
 * failed / skipped / no_ios).
 *
 * `skipped` is an optional comma-separated list of device names the caller
 * has marked skipped this session. Phase 1 keeps this in React state and
 * passes it on every call — no DB persistence.
 */
export async function GET(req: Request, res: Response) {
  const subsystemIdRaw = req.query.subsystemId
  const subsystemId = typeof subsystemIdRaw === 'string'
    ? parseInt(subsystemIdRaw, 10)
    : NaN
  if (!subsystemId || isNaN(subsystemId) || subsystemId <= 0) {
    return res.status(400).json({ error: 'Valid subsystemId query param is required' })
  }

  const skippedRaw = req.query.skipped
  const skippedSet = new Set<string>(
    typeof skippedRaw === 'string' && skippedRaw.length > 0
      ? skippedRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [],
  )

  const svg = await readBundledSvg()
  if (svg === null) {
    return res.status(500).json({ error: 'No bundled map available for ordering' })
  }

  const orderedIds = parseDeviceIdsFromSvg(svg)

  const rows = db.prepare(`
    SELECT NetworkDeviceName as deviceName,
           COUNT(*) as total,
           SUM(CASE WHEN Result = 'Passed' THEN 1 ELSE 0 END) as passed,
           SUM(CASE WHEN Result = 'Failed' THEN 1 ELSE 0 END) as failed
      FROM Ios
     WHERE SubsystemId = ?
       AND NetworkDeviceName IS NOT NULL
       AND NetworkDeviceName != ''
     GROUP BY NetworkDeviceName
  `).all(subsystemId) as IoCountRow[]

  const countsByName = new Map<string, IoCountRow>(
    rows.map(r => [r.deviceName, r]),
  )

  const devices: Device[] = orderedIds.map((deviceName, order) => {
    const counts = countsByName.get(deviceName) ?? { deviceName, total: 0, passed: 0, failed: 0 }
    const state = computeDeviceState(
      { total: counts.total, passed: counts.passed, failed: counts.failed },
      skippedSet.has(deviceName),
    )
    return {
      deviceName,
      order,
      totalIos: counts.total,
      passedIos: counts.passed,
      failedIos: counts.failed,
      untestedIos: counts.total - counts.passed - counts.failed,
      state,
    }
  })

  return res.json({ devices })
}
