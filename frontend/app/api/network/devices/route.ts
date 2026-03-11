import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/network/devices
 * Returns distinct network devices derived from IO networkDeviceName field.
 * This is a lightweight implementation until a proper NetworkDevice table exists.
 */
export async function GET() {
  try {
    // Get distinct network device names from IOs
    const ios = await prisma.io.findMany({
      where: {
        networkDeviceName: { not: null },
      },
      select: {
        networkDeviceName: true,
      },
      distinct: ['networkDeviceName'],
      orderBy: { networkDeviceName: 'asc' },
    })

    const devices = ios
      .filter(io => io.networkDeviceName)
      .map(io => ({
        name: io.networkDeviceName!,
      }))

    // Enrich with IO counts per device
    const enriched = await Promise.all(
      devices.map(async (device) => {
        const [total, passed, failed] = await Promise.all([
          prisma.io.count({ where: { networkDeviceName: device.name } }),
          prisma.io.count({ where: { networkDeviceName: device.name, result: 'Passed' } }),
          prisma.io.count({ where: { networkDeviceName: device.name, result: 'Failed' } }),
        ])
        return {
          ...device,
          totalTags: total,
          passedTags: passed,
          failedTags: failed,
          untestedTags: total - passed - failed,
        }
      })
    )

    return NextResponse.json(enriched)
  } catch (error) {
    console.error('Failed to fetch network devices:', error)
    return NextResponse.json(
      { error: 'Failed to fetch network devices' },
      { status: 500 }
    )
  }
}
