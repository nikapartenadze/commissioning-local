export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// GET — full network topology for a subsystem
export async function GET(request: NextRequest) {
  try {
    const subsystemId = request.nextUrl.searchParams.get('subsystemId')

    if (!subsystemId) {
      return NextResponse.json({ success: true, rings: [] })
    }

    const where = { subsystemId: parseInt(subsystemId, 10) }

    const rings = await prisma.networkRing.findMany({
      where,
      include: {
        nodes: {
          orderBy: { position: 'asc' as const },
          include: {
            ports: {
              orderBy: { portNumber: 'asc' as const },
            }
          }
        }
      }
    })

    return NextResponse.json({ success: true, rings })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
