export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const projectId = parseInt(params.id)
    
    if (isNaN(projectId)) {
      return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
    }

    // Get all subsystems for this project
    const subsystems = await prisma.subsystem.findMany({
      where: { projectId },
      select: { id: true, name: true }
    })

    const subsystemIds = subsystems.map(s => s.id)

    // Get all test history for IOs in these subsystems
    const history = await prisma.testHistory.findMany({
      where: {
        io: {
          subsystemId: { in: subsystemIds }
        }
      },
      include: {
        io: {
          include: {
            subsystem: true
          }
        }
      },
      orderBy: { timestamp: 'desc' },
      take: 1000 // Limit to last 1000 records for performance
    })

    // Transform to include IO and subsystem info
    const historyWithInfo = history.map(h => ({
      id: h.id,
      ioId: h.ioId,
      result: h.result,
      state: h.state,
      comments: h.comments,
      testedBy: h.testedBy,
      timestamp: h.timestamp,
      ioName: h.io.name,
      ioDescription: h.io.description,
      subsystemName: h.io.subsystem.name || `Subsystem ${h.io.subsystemId}`
    }))

    return NextResponse.json(historyWithInfo)
  } catch (error) {
    console.error('Error fetching project test history:', error)
    return NextResponse.json({ error: 'Failed to fetch test history' }, { status: 500 })
  }
}
