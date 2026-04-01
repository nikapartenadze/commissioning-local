export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST() {
  try {
    // Fetch all IOs where networkDeviceName is null and name contains ':'
    const ios = await prisma.io.findMany({
      where: {
        networkDeviceName: null,
        name: { contains: ':' },
      },
      select: { id: true, name: true },
    })

    // Group IOs by their device prefix for efficient batch updates
    const groups = new Map<string, number[]>()
    for (const io of ios) {
      const colonIndex = io.name!.indexOf(':')
      const deviceName = io.name!.substring(0, colonIndex)
      if (!deviceName) continue

      const ids = groups.get(deviceName) ?? []
      ids.push(io.id)
      groups.set(deviceName, ids)
    }

    // Batch update each group
    let updatedCount = 0
    for (const [deviceName, ids] of groups) {
      const result = await prisma.io.updateMany({
        where: { id: { in: ids } },
        data: { networkDeviceName: deviceName },
      })
      updatedCount += result.count
    }

    return NextResponse.json({
      success: true,
      updatedCount,
      deviceGroups: groups.size,
    })
  } catch (error) {
    console.error('Failed to populate device names:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to populate device names' },
      { status: 500 }
    )
  }
}
