import { Request, Response } from 'express'
import { disconnectPlc, getWsBroadcastUrl } from '@/lib/plc-client-manager';

export async function POST(req: Request, res: Response) {
  try {
    console.log('Disconnecting from PLC');

    const result = await disconnectPlc();

    if (result.success) {
      try {
        await fetch(getWsBroadcastUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'PlcConnectionChanged',
            connected: false,
          })
        });
      } catch {
        // WebSocket server might not be running
      }

      return res.json({
        success: true,
        message: 'Disconnected from PLC',
        status: result.status,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to disconnect from PLC',
        status: result.status,
      });
    }
  } catch (error) {
    console.error('PLC disconnect error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
