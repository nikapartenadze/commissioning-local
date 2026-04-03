export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { configService } from '@/lib/config'

/**
 * POST /api/cloud/pull-network
 * Pull network topology from cloud and store in local SQLite.
 * Uses saved cloud config (remoteUrl, apiPassword, subsystemId).
 */
export async function POST(request: NextRequest) {
  try {
    const config = await configService.getConfig()
    const remoteUrl = config.remoteUrl
    const apiPassword = config.apiPassword
    const subsystemId = typeof config.subsystemId === 'string' ? parseInt(config.subsystemId, 10) : config.subsystemId

    if (!remoteUrl) {
      return NextResponse.json({ success: false, error: 'Cloud URL not configured' }, { status: 400 })
    }
    if (!subsystemId) {
      return NextResponse.json({ success: false, error: 'Subsystem ID not configured' }, { status: 400 })
    }

    // Fetch network topology from cloud
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiPassword) {
      headers['X-API-Key'] = apiPassword
    }

    const cloudUrl = `${remoteUrl}/api/network?subsystemId=${subsystemId}`
    console.log(`[PullNetwork] Fetching from ${cloudUrl}`)

    const response = await fetch(cloudUrl, { headers, signal: AbortSignal.timeout(15000) })

    if (!response.ok) {
      if (response.status === 404) {
        // Cloud doesn't have network endpoint or no data — not an error
        console.log('[PullNetwork] Cloud returned 404 — no network data available')
        return NextResponse.json({ success: true, rings: 0, message: 'No network data on cloud' })
      }
      return NextResponse.json(
        { success: false, error: `Cloud returned ${response.status}` },
        { status: 502 }
      )
    }

    const data = await response.json()

    if (!data.success || !data.rings || data.rings.length === 0) {
      console.log('[PullNetwork] Cloud has no network topology data')
      return NextResponse.json({ success: true, rings: 0, message: 'No network data on cloud' })
    }

    // Delete existing local network data for this subsystem (cascade deletes nodes/ports)
    db.prepare('DELETE FROM NetworkRings WHERE SubsystemId = ?').run(subsystemId)

    // Prepared statements
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

    // Two-pass: first create all ports without parentPortId, then link sub-ports
    let totalNodes = 0
    let totalDevices = 0
    const cloudIdToLocalId = new Map<number, number>() // cloud port ID -> local port ID
    const pendingParentLinks: { localPortId: number; cloudParentId: number }[] = []

    for (const ring of data.rings) {
      const ringResult = insertRingStmt.run(
        subsystemId,
        ring.name,
        ring.mcmName,
        ring.mcmIp || null,
        ring.mcmTag || null,
      )
      const ringId = ringResult.lastInsertRowid

      for (const node of (ring.nodes || [])) {
        totalNodes++
        const nodeResult = insertNodeStmt.run(
          ringId,
          node.name,
          node.position,
          node.ipAddress || null,
          node.statusTag || null,
          node.totalPorts || 28,
        )
        const nodeId = nodeResult.lastInsertRowid

        for (const port of (node.ports || [])) {
          if (port.deviceName) totalDevices++
          const portResult = insertPortStmt.run(
            nodeId,
            port.portNumber,
            port.deviceName || null,
            port.deviceIp || null,
            port.deviceType || null,
            port.statusTag || null,
          )
          const localPortId = Number(portResult.lastInsertRowid)

          // Build cloud ID -> local ID mapping for parentPortId linking
          if (port.id) {
            cloudIdToLocalId.set(port.id, localPortId)
            if (port.parentPortId) {
              pendingParentLinks.push({ localPortId, cloudParentId: port.parentPortId })
            }
          }
        }
      }
    }

    // Second pass: link sub-ports to their parent FIOM ports
    for (const link of pendingParentLinks) {
      const localParentId = cloudIdToLocalId.get(link.cloudParentId)
      if (localParentId) {
        updatePortParentStmt.run(localParentId, link.localPortId)
      }
    }

    console.log(`[PullNetwork] Imported ${data.rings.length} rings, ${totalNodes} nodes, ${totalDevices} devices, ${pendingParentLinks.length} sub-port links`)

    return NextResponse.json({
      success: true,
      rings: data.rings.length,
      nodes: totalNodes,
      devices: totalDevices,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PullNetwork] Error:', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
