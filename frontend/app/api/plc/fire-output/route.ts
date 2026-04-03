export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'

export async function POST(request: NextRequest) {
  try {
    const { ioId } = await request.json()

    console.log(`Firing output for IO ID: ${ioId}`)

    // In a real implementation, this would write to the PLC
    // For now, we'll just log the action and return success

    // Update the IO timestamp in database (simulate PLC write)
    // Note: State is a runtime value from PLC, not stored in Io model
    db.prepare('UPDATE Ios SET Timestamp = ? WHERE id = ?').run(new Date().toISOString(), ioId)

    return NextResponse.json({
      success: true,
      message: `Output fired for IO ${ioId}`
    })
  } catch (error) {
    console.error('Failed to fire output:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fire output' },
      { status: 500 }
    )
  }
}
