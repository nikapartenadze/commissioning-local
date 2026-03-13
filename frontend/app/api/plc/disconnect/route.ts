import { NextResponse } from 'next/server';
import { disconnectPlc, getWsBroadcastUrl } from '@/lib/plc-client-manager';

export async function POST() {
  try {
    console.log('Disconnecting from PLC');

    const result = await disconnectPlc();

    if (result.success) {
      // Broadcast PLC disconnection to all WebSocket clients
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

      return NextResponse.json({
        success: true,
        message: 'Disconnected from PLC',
        status: result.status,
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Failed to disconnect from PLC',
          status: result.status,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('PLC disconnect error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
