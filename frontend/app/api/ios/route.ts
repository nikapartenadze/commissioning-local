export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { db, ioToApi } from '@/lib/db-sqlite'
import type { Io } from '@/lib/db-sqlite'
import { getPlcTags } from '@/lib/plc-client-manager'

/**
 * GET /api/ios
 * Returns all IOs with current PLC state
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const subsystemId = searchParams.get('subsystemId')

    // Fetch IOs from database
    let ios: Io[]
    if (subsystemId) {
      ios = db.prepare('SELECT * FROM Ios WHERE SubsystemId = ? ORDER BY "Order" ASC').all(parseInt(subsystemId)) as Io[]
    } else {
      ios = db.prepare('SELECT * FROM Ios ORDER BY "Order" ASC').all() as Io[]
    }

    // Get current PLC states
    const { tags, count } = getPlcTags()
    console.log(`[IOs API] Got ${count} tags from PLC client`)
    const stateMap = new Map(tags.map(t => [t.id, t.state]))

    // Get actual network device names from topology data
    const networkDevices = new Set(
      (db.prepare('SELECT DISTINCT DeviceName FROM NetworkPorts WHERE DeviceName IS NOT NULL').all() as { DeviceName: string }[])
        .map(r => r.DeviceName)
    )

    // Merge PLC states with IO data
    const iosWithState = ios.map(io => {
      const deviceName = io.NetworkDeviceName
      return {
        ...ioToApi(io),
        state: stateMap.get(io.id) ?? null,
        hasNetworkDevice: deviceName ? networkDevices.has(deviceName) : false,
        isOutput: io.Name?.includes(':O.') || io.Name?.includes(':SO.') || io.Name?.includes('.O.') || io.Name?.includes(':O:') || io.Name?.includes('.Outputs.') || io.Name?.endsWith('.DO') || io.Name?.endsWith('_DO'),
        hasResult: !!io.Result,
        isPassed: io.Result === 'Passed',
        isFailed: io.Result === 'Failed'
      }
    })

    return NextResponse.json(iosWithState)
  } catch (error) {
    console.error('Error fetching IOs:', error)
    return NextResponse.json(
      { error: 'Failed to fetch IOs' },
      { status: 500 }
    )
  }
}
