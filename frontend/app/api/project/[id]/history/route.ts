export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const projectId = parseInt(params.id)

    if (isNaN(projectId)) {
      return NextResponse.json({ error: 'Invalid project ID' }, { status: 400 })
    }

    // Get all subsystem IDs for this project
    const subsystems = db.prepare(
      'SELECT id, Name FROM Subsystems WHERE ProjectId = ?'
    ).all(projectId) as { id: number; Name: string }[]

    if (subsystems.length === 0) {
      return NextResponse.json([])
    }

    const subsystemIds = subsystems.map(s => s.id)
    const placeholders = subsystemIds.map(() => '?').join(',')

    // Get all test history for IOs in these subsystems
    const history = db.prepare(`
      SELECT th.*, i.Name as IoName, i.Description as IoDescription, i.SubsystemId,
             s.Name as SubsystemName
      FROM TestHistories th
      JOIN Ios i ON th.IoId = i.id
      JOIN Subsystems s ON i.SubsystemId = s.id
      WHERE i.SubsystemId IN (${placeholders})
      ORDER BY th.Timestamp DESC
      LIMIT 1000
    `).all(...subsystemIds) as any[]

    // Transform to include IO and subsystem info
    const historyWithInfo = history.map((h: any) => ({
      id: h.id,
      ioId: h.IoId,
      result: h.Result,
      state: h.State,
      comments: h.Comments,
      testedBy: h.TestedBy,
      timestamp: h.Timestamp,
      ioName: h.IoName,
      ioDescription: h.IoDescription,
      subsystemName: h.SubsystemName || `Subsystem ${h.SubsystemId}`
    }))

    return NextResponse.json(historyWithInfo)
  } catch (error) {
    console.error('Error fetching project test history:', error)
    return NextResponse.json({ error: 'Failed to fetch test history' }, { status: 500 })
  }
}
