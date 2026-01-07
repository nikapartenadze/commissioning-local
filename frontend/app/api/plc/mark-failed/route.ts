import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  try {
    const { ioId, comments } = await request.json()
    
    console.log(`❌ Marking test as failed for IO ID: ${ioId}`)
    
    // Update the IO result in database
    await prisma.io.update({
      where: { id: ioId },
      data: {
        result: 'Failed',
        comments: comments || '',
        timestamp: new Date().toISOString()
      }
    })
    
    // Create test history entry
    await prisma.testHistory.create({
      data: {
        ioId: ioId,
        result: 'Failed',
        comments: comments || '',
        testedBy: 'System', // In real app, this would be the current user
        timestamp: new Date().toISOString()
      }
    })
    
    return NextResponse.json({ 
      success: true, 
      message: `Test marked as failed for IO ${ioId}` 
    })
  } catch (error) {
    console.error('Failed to mark test as failed:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to mark test as failed' },
      { status: 500 }
    )
  }
}
