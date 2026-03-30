export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  try {
    const outputs = await prisma.safetyOutput.findMany({
      orderBy: { tag: 'asc' },
    })
    return NextResponse.json({ success: true, outputs })
  } catch (error) {
    return NextResponse.json({ success: false, error: 'Failed to fetch safety outputs' }, { status: 500 })
  }
}
