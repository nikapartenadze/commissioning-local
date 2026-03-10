import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const history = await prisma.testHistory.findMany({
      orderBy: { timestamp: 'desc' },
      take: 500,
      include: {
        io: {
          select: { name: true, description: true },
        },
      },
    })

    return NextResponse.json(history)
  } catch (error) {
    console.error('Failed to fetch test history:', error)
    return NextResponse.json(
      { error: 'Failed to fetch test history' },
      { status: 500 }
    )
  }
}
