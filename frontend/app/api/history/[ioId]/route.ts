import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

interface HistoryRow { id: number; IoId: number; Result: string | null; TestedBy: string | null; Timestamp: string | null; FailureMode: string | null; State: string | null; Comments: string | null; }

export async function GET(req: Request, res: Response) {
  try {
    const ioId = parseInt(req.params.ioId as string)

    if (isNaN(ioId)) {
      return res.status(400).json({ error: 'Invalid IO ID' })
    }

    const rows = db.prepare(
      'SELECT * FROM TestHistories WHERE IoId = ? ORDER BY Timestamp DESC LIMIT 100'
    ).all(ioId) as HistoryRow[]

    const history = rows.map(r => ({
      id: r.id, ioId: r.IoId, result: r.Result, testedBy: r.TestedBy, timestamp: r.Timestamp,
      failureMode: r.FailureMode, state: r.State, comments: r.Comments,
    }))

    return res.json(history)
  } catch (error) {
    console.error('Error fetching test history:', error)
    return res.status(500).json({ error: 'Failed to fetch test history' })
  }
}
