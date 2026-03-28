export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { configService } from '@/lib/config'

/**
 * POST /api/cloud/pull-estop
 * Pull EStop zone/EPC data from cloud and store in local SQLite.
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

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiPassword) {
      headers['X-API-Key'] = apiPassword
    }

    const cloudUrl = `${remoteUrl}/api/sync/estop?subsystemId=${subsystemId}`
    console.log(`[PullEStop] Fetching from ${cloudUrl}`)

    const response = await fetch(cloudUrl, { headers, signal: AbortSignal.timeout(15000) })

    if (!response.ok) {
      if (response.status === 404) {
        console.log('[PullEStop] Cloud returned 404 — no estop data available')
        return NextResponse.json({ success: true, zones: 0, message: 'No EStop data on cloud' })
      }
      return NextResponse.json(
        { success: false, error: `Cloud returned ${response.status}` },
        { status: 502 }
      )
    }

    const data = await response.json()

    if (!data.success || !data.zones || data.zones.length === 0) {
      console.log('[PullEStop] Cloud has no EStop data')
      return NextResponse.json({ success: true, zones: 0, message: 'No EStop data on cloud' })
    }

    // Delete existing local EStop data
    await prisma.eStopZone.deleteMany({})

    // Insert zones, EPCs, IO points, VFDs from cloud data
    let totalEpcs = 0
    let totalIoPoints = 0
    let totalVfds = 0

    for (const zone of data.zones) {
      await prisma.eStopZone.create({
        data: {
          name: zone.name,
          epcs: {
            create: (zone.epcs || []).map((epc: any) => {
              totalEpcs++
              return {
                name: epc.name,
                checkTag: epc.checkTag,
                ioPoints: {
                  create: (epc.ioPoints || []).map((io: any) => {
                    totalIoPoints++
                    return { tag: io.tag }
                  }),
                },
                vfds: {
                  create: (epc.vfds || []).map((vfd: any) => {
                    totalVfds++
                    return {
                      tag: vfd.tag,
                      stoTag: vfd.stoTag,
                      mustStop: vfd.mustStop,
                    }
                  }),
                },
              }
            }),
          },
        },
      })
    }

    console.log(`[PullEStop] Imported ${data.zones.length} zones, ${totalEpcs} EPCs, ${totalIoPoints} IO points, ${totalVfds} VFDs`)

    return NextResponse.json({
      success: true,
      zones: data.zones.length,
      epcs: totalEpcs,
      ioPoints: totalIoPoints,
      vfds: totalVfds,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PullEStop] Error:', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
