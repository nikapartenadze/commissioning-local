import { NextRequest, NextResponse } from 'next/server'

// Use globalThis to persist testing state across requests
const globalForTesting = globalThis as unknown as {
  isTestingEnabled: boolean | undefined;
};

if (globalForTesting.isTestingEnabled === undefined) {
  globalForTesting.isTestingEnabled = false;
}

export async function POST(request: NextRequest) {
  try {
    // Toggle the current state (no body needed, just toggle)
    let newState: boolean;

    try {
      const body = await request.json();
      // If body has explicit enabled value, use it
      if (typeof body.enabled === 'boolean') {
        newState = body.enabled;
      } else {
        // Otherwise toggle
        newState = !globalForTesting.isTestingEnabled;
      }
    } catch {
      // No body or invalid JSON - just toggle
      newState = !globalForTesting.isTestingEnabled;
    }

    globalForTesting.isTestingEnabled = newState;

    console.log(`🔄 Testing mode: ${newState ? 'ON' : 'OFF'}`)

    // Broadcast to WebSocket clients
    try {
      const { getWsBroadcastUrl } = await import('@/lib/plc-client-manager')
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'TestingStateChanged',
          isTesting: newState
        })
      });
    } catch {
      // WebSocket server might not be running
    }

    return NextResponse.json({
      success: true,
      isTesting: newState,
      message: `Testing mode ${newState ? 'started' : 'stopped'}`
    })
  } catch (error) {
    console.error('Failed to toggle testing mode:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to toggle testing mode' },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    isTesting: globalForTesting.isTestingEnabled || false
  });
}
