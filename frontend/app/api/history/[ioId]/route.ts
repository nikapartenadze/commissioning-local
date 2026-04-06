export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

interface HistoryRow {
  id: number;
  IoId: number;
  Result: string | null;
  TestedBy: string | null;
  Timestamp: string | null;
  FailureMode: string | null;
  State: string | null;
  Comments: string | null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ioId: string }> }
) {
  try {
    const { ioId: ioIdStr } = await params
    const ioId = parseInt(ioIdStr)

    if (isNaN(ioId)) {
      return NextResponse.json({ error: 'Invalid IO ID' }, { status: 400 })
    }

    const rows = db.prepare(
      'SELECT * FROM TestHistories WHERE IoId = ? ORDER BY Timestamp DESC LIMIT 100'
    ).all(ioId) as HistoryRow[]

    const history = rows.map(r => ({
      id: r.id,
      ioId: r.IoId,
      result: r.Result,
      testedBy: r.TestedBy,
      timestamp: r.Timestamp,
      failureMode: r.FailureMode,
      state: r.State,
      comments: r.Comments,
    }))

    return NextResponse.json(history)
  } catch (error) {
    console.error('Error fetching test history:', error)
    return NextResponse.json({ error: 'Failed to fetch test history' }, { status: 500 })
  }
}
