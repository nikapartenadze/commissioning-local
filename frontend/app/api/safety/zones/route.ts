export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  try {
    const zones = await prisma.safetyZone.findMany({
      include: { drives: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ success: true, zones })
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to fetch safety zones' }, { status: 500 })
  }
}
