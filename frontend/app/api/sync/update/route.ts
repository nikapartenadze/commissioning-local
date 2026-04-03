export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Handle single IO update
    if (body.Id) {
      const { Id, Result, State, Timestamp, Comments } = body

      const stmt = db.prepare(
        'UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ? WHERE id = ?'
      )
      stmt.run(Result, Timestamp, Comments, Id)

      const updatedIo = db.prepare('SELECT * FROM Ios WHERE id = ?').get(Id)

      return NextResponse.json({ success: true, io: updatedIo })
    }

    // Handle batch IO updates
    if (body.Ios && Array.isArray(body.Ios)) {
      const stmt = db.prepare(
        'UPDATE Ios SET Result = ?, Timestamp = ?, Comments = ? WHERE id = ?'
      )

      let updatedCount = 0
      const totalCount = body.Ios.length

      for (const io of body.Ios) {
        try {
          const result = stmt.run(io.Result, io.Timestamp, io.Comments, io.Id)
          if (result.changes > 0) updatedCount++
        } catch (error) {
          console.error(`Failed to update IO ${io.Id}:`, error)
        }
      }

      return NextResponse.json({
        success: true,
        updatedCount,
        totalCount
      })
    }

    return NextResponse.json({ error: 'Invalid request format' }, { status: 400 })

  } catch (error) {
    console.error('Error updating IOs:', error)
    return NextResponse.json(
      { error: 'Failed to update IOs' },
      { status: 500 }
    )
  }
}
