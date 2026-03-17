export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  try {
    const { ioId } = await request.json()
    
    console.log(`🔥 Firing output for IO ID: ${ioId}`)
    
    // In a real implementation, this would write to the PLC
    // For now, we'll just log the action and return success
    
    // Update the IO timestamp in database (simulate PLC write)
    // Note: State is a runtime value from PLC, not stored in Io model
    await prisma.io.update({
      where: { id: ioId },
      data: {
        timestamp: new Date().toISOString()
      }
    })
    
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
