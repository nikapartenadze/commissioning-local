import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const projectId = parseInt(params.id)
    
    if (isNaN(projectId)) {
      return NextResponse.json(
        { error: 'Invalid project ID' },
        { status: 400 }
      )
    }

    // Get all IOs for the project with subsystem information
    const ios = await prisma.io.findMany({
      where: {
        subsystem: {
          projectId: projectId
        }
      },
      include: {
        subsystem: {
          select: {
            name: true
          }
        }
      },
      orderBy: [
        { subsystem: { name: 'asc' } },
        { name: 'asc' }
      ]
    })

    // Transform the data to match the expected format
    // Note: state is a runtime PLC value, not stored in database
    // Real-time state values come from SignalR/PLC connections
    const transformedIos = ios.map(io => ({
      id: io.id,
      name: io.name,
      description: io.description,
      result: io.result,
      timestamp: io.timestamp,
      comments: io.comments,
      state: null, // State is runtime value from PLC, not in database
      subsystemName: io.subsystem.name
    }))

    return NextResponse.json(transformedIos)
  } catch (error) {
    console.error('Error fetching project IOs:', error)
    return NextResponse.json(
      { error: 'Failed to fetch project IOs' },
      { status: 500 }
    )
  }
}
