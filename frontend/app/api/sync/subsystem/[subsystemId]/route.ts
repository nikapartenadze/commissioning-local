export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

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
    const ios = db.prepare(
      'SELECT * FROM Ios WHERE SubsystemId = ? ORDER BY "Order" ASC, Name ASC'
    ).all(subsystemId) as any[]

    // Transform to match C# expected format
    // Note: state is a runtime PLC value, not stored in database
    // Real-time state values come from SignalR/PLC connections
    const transformedIos = ios.map(io => ({
      Id: io.id,
      Name: io.Name,
      Description: io.Description,
      State: null, // State is runtime value from PLC, not in database
      Result: io.Result,
      Timestamp: io.Timestamp,
      Comments: io.Comments,
      Order: io.Order,
      Version: io.Version,
      SubsystemId: io.SubsystemId
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
