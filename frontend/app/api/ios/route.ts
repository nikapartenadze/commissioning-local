import { Request, Response } from 'express'
import { db, ioToApi } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags } from '@/lib/plc-client-manager'
import { isOutputIo } from '@/lib/io-classification'
import { getAllTags, getMcmTags, hasAnyMcm, hasMcm } from '@/lib/mcm-registry'

// Module-level prepared statements — compiled once, reused per request (this
// route used to re-prepare all four on EVERY call; follows the pattern of
// app/api/l2/cell/route.ts).
const stmts = {
  iosBySubsystem: db.prepare('SELECT * FROM Ios WHERE SubsystemId = ? ORDER BY "Order" ASC'),
  iosAll: db.prepare('SELECT * FROM Ios ORDER BY "Order" ASC'),
  networkDeviceNames: db.prepare('SELECT DISTINCT DeviceName FROM NetworkPorts WHERE DeviceName IS NOT NULL'),
  subsystemWithProject: db.prepare(
    'SELECT s.Name as subName, p.Name as projName FROM Subsystems s JOIN Projects p ON s.ProjectId = p.id WHERE s.id = ?'
  ),
}

/**
 * GET /api/ios
 * Returns all IOs with current PLC state
 */
export async function GET(req: Request, res: Response) {
  try {
    const subsystemId = req.query.subsystemId as string | undefined

    let ios: Io[]
    if (subsystemId) {
      ios = stmts.iosBySubsystem.all(parseInt(subsystemId)) as Io[]
    } else {
      ios = stmts.iosAll.all() as Io[]
    }

    // Multi-MCM: scope tag-state lookup to the requested MCM when known,
    // otherwise union across every registered MCM. Singleton fallback is
    // unchanged when no MCMs are registered.
    let stateMap: Map<number, string | undefined>
    if (hasAnyMcm()) {
      if (subsystemId && hasMcm(subsystemId)) {
        const { tags: mcmTags } = getMcmTags(subsystemId)
        stateMap = new Map(mcmTags.map((t) => [t.id, t.state]))
        console.log(`[IOs API] Multi-MCM ${subsystemId}: ${mcmTags.length} tags`)
      } else {
        const { tags: allTags, count } = getAllTags()
        stateMap = new Map(allTags.map((t) => [t.id, t.state]))
        console.log(`[IOs API] Multi-MCM union: ${count} tags across all MCMs`)
      }
    } else {
      const { tags, count } = getPlcTags()
      console.log(`[IOs API] Singleton: ${count} tags from PLC client`)
      stateMap = new Map(tags.map((t) => [t.id, t.state]))
    }

    const networkDevices = new Set(
      (stmts.networkDeviceNames.all() as { DeviceName: string }[])
        .map(r => r.DeviceName)
    )

    const iosWithState = ios.map(io => {
      const deviceName = io.NetworkDeviceName
      return {
        ...ioToApi(io),
        state: stateMap.get(io.id) ?? null,
        hasNetworkDevice: deviceName ? networkDevices.has(deviceName) : false,
        isOutput: isOutputIo(io.Name, io.Description),
        hasResult: !!io.Result,
        isPassed: io.Result === 'Passed',
        isFailed: io.Result === 'Failed'
      }
    })

    let projectName: string | null = null
    let subsystemName: string | null = null
    const lookupSubId = subsystemId || (ios.length > 0 ? String(ios[0].SubsystemId) : null)
    if (lookupSubId) {
      const sub = stmts.subsystemWithProject.get(parseInt(lookupSubId)) as { subName: string | null; projName: string | null } | undefined
      if (sub) {
        projectName = sub.projName
        subsystemName = sub.subName
      }
    }

    return res.json({ ios: iosWithState, projectName, subsystemName })
  } catch (error) {
    console.error('Error fetching IOs:', error)
    return res.status(500).json({ error: 'Failed to fetch IOs' })
  }
}
