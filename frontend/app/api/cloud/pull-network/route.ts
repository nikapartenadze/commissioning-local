import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

export async function POST(req: Request, res: Response) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    // Scope by the REQUESTED subsystem (central multi-MCM), not the singleton
    // config.subsystemId. Central pages MUST pass subsystemId in the body;
    // single-MCM tablets fall back to config.
    const bodySubsystemId = req.body?.subsystemId
    const rawSubsystemId = bodySubsystemId != null ? bodySubsystemId
      : (typeof config.subsystemId === 'string' ? parseInt(config.subsystemId, 10) : config.subsystemId)
    const subsystemId = typeof rawSubsystemId === 'string' ? parseInt(rawSubsystemId, 10) : rawSubsystemId

    if (!remoteUrl) {
      return res.status(400).json({ success: false, error: 'Cloud URL not configured' })
    }
    if (!subsystemId || !Number.isFinite(subsystemId)) {
      return res.status(400).json({ success: false, error: 'Subsystem ID not configured' })
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiPassword) {
      headers['X-API-Key'] = apiPassword
    }

    const cloudUrl = `${remoteUrl}/api/network?subsystemId=${subsystemId}`
    console.log(`[PullNetwork] Fetching from ${cloudUrl}`)

    const response = await fetch(cloudUrl, { headers, signal: AbortSignal.timeout(15000) })

    if (!response.ok) {
      if (response.status === 404) {
        console.log('[PullNetwork] Cloud returned 404 — no network data available')
        return res.json({ success: true, rings: 0, message: 'No network data on cloud' })
      }
      return res.status(502).json({ success: false, error: `Cloud returned ${response.status}` })
    }

    const data = await response.json()

    if (!data.success || !data.rings || data.rings.length === 0) {
      console.log('[PullNetwork] Cloud has no network topology data')
      return res.json({ success: true, rings: 0, message: 'No network data on cloud' })
    }

    db.prepare('DELETE FROM NetworkRings WHERE SubsystemId = ?').run(subsystemId)

    const insertRingStmt = db.prepare(
      'INSERT INTO NetworkRings (SubsystemId, Name, McmName, McmIp, McmTag) VALUES (?, ?, ?, ?, ?)'
    )
    const insertNodeStmt = db.prepare(
      'INSERT INTO NetworkNodes (RingId, Name, Position, IpAddress, StatusTag, TotalPorts) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const insertPortStmt = db.prepare(
      'INSERT INTO NetworkPorts (NodeId, PortNumber, DeviceName, DeviceIp, DeviceType, StatusTag) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const updatePortParentStmt = db.prepare(
      'UPDATE NetworkPorts SET ParentPortId = ? WHERE id = ?'
    )

    let totalNodes = 0
    let totalDevices = 0
    const cloudIdToLocalId = new Map<number, number>()
    const pendingParentLinks: { localPortId: number; cloudParentId: number }[] = []

    for (const ring of data.rings) {
      const ringResult = insertRingStmt.run(subsystemId, ring.name, ring.mcmName, ring.mcmIp || null, ring.mcmTag || null)
      const ringId = ringResult.lastInsertRowid

      for (const node of (ring.nodes || [])) {
        totalNodes++
        const nodeResult = insertNodeStmt.run(ringId, node.name, node.position, node.ipAddress || null, node.statusTag || null, node.totalPorts || 28)
        const nodeId = nodeResult.lastInsertRowid

        for (const port of (node.ports || [])) {
          if (port.deviceName) totalDevices++
          const portResult = insertPortStmt.run(nodeId, port.portNumber, port.deviceName || null, port.deviceIp || null, port.deviceType || null, port.statusTag || null)
          const localPortId = Number(portResult.lastInsertRowid)

          if (port.id) {
            cloudIdToLocalId.set(port.id, localPortId)
            if (port.parentPortId) {
              pendingParentLinks.push({ localPortId, cloudParentId: port.parentPortId })
            }
          }
        }
      }
    }

    for (const link of pendingParentLinks) {
      const localParentId = cloudIdToLocalId.get(link.cloudParentId)
      if (localParentId) {
        updatePortParentStmt.run(localParentId, link.localPortId)
      }
    }

    console.log(`[PullNetwork] Imported ${data.rings.length} rings, ${totalNodes} nodes, ${totalDevices} devices, ${pendingParentLinks.length} sub-port links`)

    return res.json({ success: true, rings: data.rings.length, nodes: totalNodes, devices: totalDevices })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PullNetwork] Error:', message)
    return res.status(500).json({ success: false, error: message })
  }
}
