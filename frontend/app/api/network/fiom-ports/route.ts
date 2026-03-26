export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// GET /api/network/fiom-ports?fiomName=NCP1_17_FIOM1&subsystemId=47
// Returns FIOM port data derived from IO tag names matching {fiomName}_X{n}.PIN{n}_{type}
export async function GET(request: NextRequest) {
  try {
    const fiomName = request.nextUrl.searchParams.get('fiomName')
    const subsystemId = request.nextUrl.searchParams.get('subsystemId')

    if (!fiomName) {
      return NextResponse.json({ error: 'fiomName required' }, { status: 400 })
    }

    const where: any = {
      name: { startsWith: `${fiomName}_X` },
    }
    if (subsystemId) {
      where.subsystemId = parseInt(subsystemId, 10)
    }

    const ios = await prisma.io.findMany({
      where,
      select: { name: true, description: true },
      orderBy: { name: 'asc' },
    })

    // Parse IO names into port structure
    // Pattern: {fiomName}_X{portNum}.PIN{pinNum}_{DI/DO}
    const portMap = new Map<number, { portNum: number; pins: { pin: number; type: string; ioName: string; description: string }[] }>()

    for (const io of ios) {
      const match = io.name.match(/_X(\d+)\.PIN(\d+)_(D[IO])$/)
      if (!match) continue

      const portNum = parseInt(match[1])
      const pinNum = parseInt(match[2])
      const pinType = match[3] // DI or DO

      if (!portMap.has(portNum)) {
        portMap.set(portNum, { portNum, pins: [] })
      }
      portMap.get(portNum)!.pins.push({
        pin: pinNum,
        type: pinType,
        ioName: io.name,
        description: io.description || 'SPARE',
      })
    }

    const ports = Array.from(portMap.values()).sort((a, b) => a.portNum - b.portNum)

    return NextResponse.json({
      success: true,
      fiomName,
      totalPorts: ports.length,
      ports,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
