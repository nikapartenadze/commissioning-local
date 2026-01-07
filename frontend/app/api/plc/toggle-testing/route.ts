import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const { enabled } = await request.json()
    
    console.log(`🔄 Toggling testing mode: ${enabled ? 'ON' : 'OFF'}`)
    
    // In a real implementation, this would communicate with the PLC
    // to start/stop the testing watchdog
    
    return NextResponse.json({ 
      success: true, 
      enabled,
      message: `Testing mode ${enabled ? 'started' : 'stopped'}` 
    })
  } catch (error) {
    console.error('Failed to toggle testing mode:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to toggle testing mode' },
      { status: 500 }
    )
  }
}
