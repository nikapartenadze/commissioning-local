export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

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
    const ios = db.prepare(`
      SELECT i.*, s.Name as SubsystemName
      FROM Ios i
      JOIN Subsystems s ON i.SubsystemId = s.id
      WHERE s.ProjectId = ?
      ORDER BY s.Name ASC, i.Name ASC
    `).all(projectId) as any[]

    // Transform the data to match the expected format
    const transformedIos = ios.map((io: any) => ({
      id: io.id,
      name: io.Name,
      description: io.Description,
      result: io.Result,
      timestamp: io.Timestamp,
      comments: io.Comments,
      state: null, // State is runtime value from PLC, not in database
      subsystemName: io.SubsystemName
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
