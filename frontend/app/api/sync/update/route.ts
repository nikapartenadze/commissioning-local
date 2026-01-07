import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Handle single IO update
    if (body.Id) {
      const { Id, Result, State, Timestamp, Comments } = body
      
      const updatedIo = await prisma.io.update({
        where: { id: Id },
        data: {
          result: Result,
          // Note: State is a runtime PLC value, not stored in Io model
          // State changes are tracked in TestHistory if needed
          timestamp: Timestamp,
          comments: Comments
        }
      })

      return NextResponse.json({ success: true, io: updatedIo })
    }
    
    // Handle batch IO updates
    if (body.Ios && Array.isArray(body.Ios)) {
      const updates = body.Ios.map((io: any) => ({
        where: { id: io.Id },
        data: {
          result: io.Result,
          // Note: State is a runtime PLC value, not stored in Io model
          timestamp: io.Timestamp,
          comments: io.Comments
        }
      }))

      // Process updates in batches
      const results = []
      for (const update of updates) {
        try {
          const result = await prisma.io.update(update)
          results.push(result)
        } catch (error) {
          console.error(`Failed to update IO ${update.where.id}:`, error)
        }
      }

      return NextResponse.json({ 
        success: true, 
        updatedCount: results.length,
        totalCount: updates.length
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
