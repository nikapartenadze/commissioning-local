import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export const dynamic = 'force-dynamic'

interface HistoryRow {
  id: number;
  IoId: number;
  Result: string | null;
  TestedBy: string | null;
  Timestamp: string | null;
  FailureMode: string | null;
  State: string | null;
  Comments: string | null;
  IoName: string | null;
  IoDescription: string | null;
}

export async function GET() {
  try {
    const rows = db.prepare(`
      SELECT th.*, i.Name as IoName, i.Description as IoDescription
      FROM TestHistories th
      LEFT JOIN Ios i ON th.IoId = i.id
      ORDER BY th.Timestamp DESC
      LIMIT 500
    `).all() as HistoryRow[]

    const history = rows.map(r => ({
      id: r.id,
      ioId: r.IoId,
      result: r.Result,
      testedBy: r.TestedBy,
      timestamp: r.Timestamp,
      failureMode: r.FailureMode,
      state: r.State,
      comments: r.Comments,
      io: {
        name: r.IoName,
        description: r.IoDescription,
      },
    }))

    return NextResponse.json(history)
  } catch (error) {
    console.error('Failed to fetch test history:', error)
    return NextResponse.json(
      { error: 'Failed to fetch test history' },
      { status: 500 }
    )
  }
}
