export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
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

    // Delete existing local network data for this subsystem
    // Find local subsystem — the subsystemId in config refers to the CLOUD subsystem ID.
    // Locally we store it by the same subsystemId.
    await prisma.networkRing.deleteMany({ where: { subsystemId } })

    // Insert rings, nodes, ports from cloud data
    // Two-pass: first create all ports without parentPortId, then link sub-ports
    let totalNodes = 0
    let totalDevices = 0
    const cloudIdToLocalId = new Map<number, number>() // cloud port ID → local port ID
    const pendingParentLinks: { localPortId: number; cloudParentId: number }[] = []

    for (const ring of data.rings) {
      const createdRing = await prisma.networkRing.create({
        data: {
          subsystemId,
          name: ring.name,
          mcmName: ring.mcmName,
          mcmIp: ring.mcmIp || null,
          mcmTag: ring.mcmTag || null,
          nodes: {
            create: (ring.nodes || []).map((node: any) => {
              totalNodes++
              return {
                name: node.name,
                position: node.position,
                ipAddress: node.ipAddress || null,
                statusTag: node.statusTag || null,
                totalPorts: node.totalPorts || 28,
                ports: {
                  create: (node.ports || []).map((port: any) => {
                    if (port.deviceName) totalDevices++
                    return {
                      portNumber: port.portNumber,
                      deviceName: port.deviceName || null,
                      deviceIp: port.deviceIp || null,
                      deviceType: port.deviceType || null,
                      statusTag: port.statusTag || null,
                    }
                  }),
                },
              }
            }),
          },
        },
        include: { nodes: { include: { ports: true } } },
      })

      // Build cloud ID → local ID mapping for parentPortId linking
      for (const node of createdRing.nodes) {
        const cloudNode = (ring.nodes || []).find((n: any) => n.name === node.name)
        if (!cloudNode) continue
        for (const localPort of node.ports) {
          const cloudPort = (cloudNode.ports || []).find((p: any) => p.portNumber === localPort.portNumber)
          if (cloudPort?.id) {
            cloudIdToLocalId.set(cloudPort.id, localPort.id)
            if (cloudPort.parentPortId) {
              pendingParentLinks.push({ localPortId: localPort.id, cloudParentId: cloudPort.parentPortId })
            }
          }
        }
      }
    }

    // Second pass: link sub-ports to their parent FIOM ports
    for (const link of pendingParentLinks) {
      const localParentId = cloudIdToLocalId.get(link.cloudParentId)
      if (localParentId) {
        await prisma.networkPort.update({
          where: { id: link.localPortId },
          data: { parentPortId: localParentId },
        })
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
