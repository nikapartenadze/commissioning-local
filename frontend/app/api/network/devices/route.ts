import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export const dynamic = 'force-dynamic'

/**
 * GET /api/network/devices
 * Returns distinct network devices derived from IO networkDeviceName field.
 * This is a lightweight implementation until a proper NetworkDevice table exists.
 */
export async function GET() {
  try {
    // Get distinct network device names from IOs
    const devices = db.prepare(
      'SELECT DISTINCT NetworkDeviceName FROM Ios WHERE NetworkDeviceName IS NOT NULL ORDER BY NetworkDeviceName ASC'
    ).all() as { NetworkDeviceName: string }[]

    // Enrich with IO counts per device
    const countStmt = db.prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN Result = ? THEN 1 ELSE 0 END) as passed, SUM(CASE WHEN Result = ? THEN 1 ELSE 0 END) as failed FROM Ios WHERE NetworkDeviceName = ?'
    )

    const enriched = devices.map(device => {
      const counts = countStmt.get('Passed', 'Failed', device.NetworkDeviceName) as { total: number; passed: number; failed: number }
      return {
        name: device.NetworkDeviceName,
        totalTags: counts.total,
        passedTags: counts.passed,
        failedTags: counts.failed,
        untestedTags: counts.total - counts.passed - counts.failed,
      }
    })

    return NextResponse.json(enriched)
  } catch (error) {
    console.error('Failed to fetch network devices:', error)
    return NextResponse.json(
      { error: 'Failed to fetch network devices' },
      { status: 500 }
    )
  }
}
