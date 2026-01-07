import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(
  request: NextRequest,
  { params }: { params: { subsystemId: string } }
) {
  try {
    const subsystemId = parseInt(params.subsystemId)
    
    if (isNaN(subsystemId)) {
      return NextResponse.json({ error: 'Invalid subsystem ID' }, { status: 400 })
    }

    // Get IOs for the specified subsystem
    // Note: Prisma uses camelCase (subsystemId) even though DB column is lowercase (subsystemid)
    const ios = await prisma.io.findMany({
      where: {
        subsystemId: subsystemId
      },
      orderBy: [
        { order: 'asc' },  // Prisma field is 'order', DB column is 'Order'
        { name: 'asc' }
      ]
    })

    // Transform to match C# expected format
    // Note: state is a runtime PLC value, not stored in database
    // Real-time state values come from SignalR/PLC connections
    const transformedIos = ios.map(io => ({
      Id: io.id,
      Name: io.name,
      Description: io.description,
      State: null, // State is runtime value from PLC, not in database
      Result: io.result,
      Timestamp: io.timestamp,
      Comments: io.comments,
      Order: io.order,  // Prisma field is 'order' (lowercase)
      Version: io.version,
      SubsystemId: io.subsystemId  // Prisma field is 'subsystemId' (camelCase)
    }))

    return NextResponse.json({
      Ios: transformedIos
    })

  } catch (error) {
    console.error('Error fetching subsystem IOs:', error)
    return NextResponse.json(
      { error: 'Failed to fetch subsystem IOs' },
      { status: 500 }
    )
  }
}
