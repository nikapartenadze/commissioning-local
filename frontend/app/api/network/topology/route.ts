export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

// GET — full network topology for a subsystem
export async function GET(request: NextRequest) {
  try {
    const subsystemId = request.nextUrl.searchParams.get('subsystemId')

    if (!subsystemId) {
      return NextResponse.json({ success: true, rings: [] })
    }

    const rings = db.prepare('SELECT * FROM NetworkRings WHERE SubsystemId = ?').all(parseInt(subsystemId, 10)) as any[]

    for (const ring of rings) {
      ring.nodes = db.prepare('SELECT * FROM NetworkNodes WHERE RingId = ? ORDER BY Position').all(ring.id) as any[]
      for (const node of ring.nodes) {
        node.ports = db.prepare('SELECT * FROM NetworkPorts WHERE NodeId = ? ORDER BY PortNumber').all(node.id) as any[]
      }
    }

    return NextResponse.json({ success: true, rings })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
