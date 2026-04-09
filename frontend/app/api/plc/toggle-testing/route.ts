import { Request, Response } from 'express'

const globalForTesting = globalThis as unknown as {
  isTestingUsers: Set<string> | undefined;
};

if (globalForTesting.isTestingUsers === undefined) {
  globalForTesting.isTestingUsers = new Set<string>();
}

export async function POST(req: Request, res: Response) {
  try {
    let userName: string | undefined;
    let explicitEnabled: boolean | undefined;

    try {
      if (req.body) {
        userName = req.body.userName;
        if (typeof req.body.enabled === 'boolean') {
          explicitEnabled = req.body.enabled;
        }
      }
    } catch {
      // No body or invalid JSON
    }

    if (!userName) {
      return res.status(400).json({ success: false, error: 'userName is required' });
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
      if (users.has(userName)) {
        users.delete(userName);
        userIsTesting = false;
      } else {
        users.add(userName);
        userIsTesting = true;
      }
    }

    console.log(`Testing mode for ${userName}: ${userIsTesting ? 'ON' : 'OFF'} (active users: ${Array.from(users).join(', ') || 'none'})`)

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

    return res.json({
      success: true,
      isTesting: userIsTesting,
      isTestingUsers: Array.from(users),
      message: `Testing mode ${userIsTesting ? 'started' : 'stopped'} for ${userName}`
    })
  } catch (error) {
    console.error('Failed to toggle testing mode:', error)
    return res.status(500).json({ success: false, error: 'Failed to toggle testing mode' })
  }
}

export async function GET(req: Request, res: Response) {
  const users = globalForTesting.isTestingUsers || new Set<string>();
  return res.json({
    success: true,
    isTesting: users.size > 0,
    isTestingUsers: Array.from(users),
  });
}
