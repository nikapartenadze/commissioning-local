import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  request: Request,
  { params }: { params: { ioId: string } }
) {
  try {
    const ioId = parseInt(params.ioId)
    
    if (isNaN(ioId)) {
      return NextResponse.json({ error: 'Invalid IO ID' }, { status: 400 })
    }

    const history = await prisma.testHistory.findMany({
      where: { ioId },
      orderBy: { timestamp: 'desc' },
      take: 100
    })

    return NextResponse.json(history)
  } catch (error) {
    console.error('Error fetching test history:', error)
    return NextResponse.json({ error: 'Failed to fetch test history' }, { status: 500 })
  }
}

