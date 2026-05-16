import type { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { parseDeviceIdsFromSvg } from '@/lib/guided/svg-parser'
import { computeDeviceState } from '@/lib/guided/device-state'
import { readBundledSvg } from '@/app/api/maps/subsystem/[id]/route'
import type { Device } from '@/lib/guided/types'

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

  // Pull every IO for this subsystem ONCE. We compute counts per SVG
  // device in JS rather than per-id SQL because each SVG id can match an
  // IO three different ways:
  //   1) NetworkDeviceName === id              (VFDs / FIOMs)
  //   2) NetworkDeviceName === id + '_PD'      (laser photoeyes — LPE alias)
  //   3) Description starts with "id " or
  //      "id_"                                (photoeyes / beacons / EPCs
  //                                            whose physical name lives
  //                                            in the IO's Description
  //                                            field while NetworkDeviceName
  //                                            is the parent FIOM or VFD)
  //
  // With 228 IOs × 138 SVG ids that's ~31k cheap comparisons — well under
  // the cost of a single per-id round-trip.
  interface IoRow {
    NetworkDeviceName: string | null
    Description: string | null
    Result: string | null
  }
  const allIos = db.prepare(`
    SELECT NetworkDeviceName, Description, Result
      FROM Ios
     WHERE SubsystemId = ?
  `).all(subsystemId) as IoRow[]

  const devices: Device[] = orderedIds.map((deviceName, order) => {
    let total = 0, passed = 0, failed = 0
    const exactSpace = deviceName + ' '
    const underscoreSub = deviceName + '_'
    const pdAlias = deviceName + '_PD'
    for (const r of allIos) {
      const ndn = r.NetworkDeviceName
      const matchesNDN = ndn === deviceName || ndn === pdAlias
      let matchesDesc = false
      if (!matchesNDN && r.Description) {
        const d = r.Description
        matchesDesc = d.startsWith(exactSpace) || d.startsWith(underscoreSub)
      }
      if (matchesNDN || matchesDesc) {
        total++
        if (r.Result === 'Passed') passed++
        else if (r.Result === 'Failed') failed++
      }
    }
    const state = computeDeviceState(
      { total, passed, failed },
      skippedSet.has(deviceName),
    )
    return {
      deviceName,
      order,
      totalIos: total,
      passedIos: passed,
      failedIos: failed,
      untestedIos: total - passed - failed,
      state,
    }
  })

  return res.json({ devices })
}
