import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'

export async function POST(req: Request, res: Response) {
  try {
    const body = req.body

    if (body.Id) {
      const { Id, Result, State, Timestamp, Comments } = body
      db.prepare('UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ? WHERE id = ?').run(Result, Timestamp, Comments, Id)
      const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(Id)
      return res.json({ success: true, io: updatedIo })
    }

    if (body.Ios && Array.isArray(body.Ios)) {
      const stmt = db.prepare('UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ? WHERE id = ?')
      let updatedCount = 0
      for (const io of body.Ios) {
        try { const result = stmt.run(io.Result, io.Timestamp, io.Comments, io.Id); if (result.changes > 0) updatedCount++ } catch (error) { console.error(`Failed to update IO ${io.Id}:`, error) }
      }
      return res.json({ success: true, updatedCount, totalCount: body.Ios.length })
    }

    return res.status(400).json({ error: 'Invalid request format' })
  } catch (error) {
    console.error('Error updating IOs:', error)
    return res.status(500).json({ error: 'Failed to update IOs' })
  }
}
