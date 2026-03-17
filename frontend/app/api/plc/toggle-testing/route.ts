export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server'

// Use globalThis to persist testing state across requests
const globalForTesting = globalThis as unknown as {
  isTestingUsers: Set<string> | undefined;
};

if (globalForTesting.isTestingUsers === undefined) {
  globalForTesting.isTestingUsers = new Set<string>();
}

export async function POST(request: NextRequest) {
  try {
    let userName: string | undefined;
    let explicitEnabled: boolean | undefined;

    try {
      const body = await request.json();
      userName = body.userName;
      if (typeof body.enabled === 'boolean') {
        explicitEnabled = body.enabled;
      }
    } catch {
      // No body or invalid JSON
    }

    if (!userName) {
      return NextResponse.json(
        { success: false, error: 'userName is required' },
        { status: 400 }
      );
    }

    const users = globalForTesting.isTestingUsers!;
    let userIsTesting: boolean;

    if (explicitEnabled !== undefined) {
      if (explicitEnabled) {
        users.add(userName);
      } else {
        users.delete(userName);
      }
      userIsTesting = explicitEnabled;
    } else {
      // Toggle
      if (users.has(userName)) {
        users.delete(userName);
        userIsTesting = false;
      } else {
        users.add(userName);
        userIsTesting = true;
      }
    }

    console.log(`🔄 Testing mode for ${userName}: ${userIsTesting ? 'ON' : 'OFF'} (active users: ${Array.from(users).join(', ') || 'none'})`)

    // Broadcast to WebSocket clients
    try {
      const { getWsBroadcastUrl } = await import('@/lib/plc-client-manager')
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'TestingStateChanged',
          isTesting: users.size > 0,
          isTestingUsers: Array.from(users),
          changedUser: userName,
        })
      });
    } catch {
      // WebSocket server might not be running
    }

    return NextResponse.json({
      success: true,
      isTesting: userIsTesting,
      isTestingUsers: Array.from(users),
      message: `Testing mode ${userIsTesting ? 'started' : 'stopped'} for ${userName}`
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
  const users = globalForTesting.isTestingUsers || new Set<string>();
  return NextResponse.json({
    success: true,
    isTesting: users.size > 0,
    isTestingUsers: Array.from(users),
  });
}
