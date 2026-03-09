import { NextRequest, NextResponse } from 'next/server';
import { getPlcSimulator } from '@/lib/services/plc-simulator-service';
import { getPlcWebSocketServer } from '@/lib/plc/websocket-server';

/**
 * POST /api/simulator/enable
 *
 * Enable the PLC simulator with optional interval configuration.
 *
 * Query Parameters:
 * - intervalMs: Update interval in milliseconds (500-10000, default: 2000)
 */
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const intervalMsParam = searchParams.get('intervalMs');
    const intervalMs = intervalMsParam ? parseInt(intervalMsParam, 10) : 2000;

    // Validate interval
    if (intervalMs < 500 || intervalMs > 10000) {
      return NextResponse.json(
        {
          success: false,
          error: 'Interval must be between 500ms and 10000ms',
        },
        { status: 400 }
      );
    }

    const simulator = getPlcSimulator();

    // Set up event listener to broadcast state changes via WebSocket
    const wsServer = getPlcWebSocketServer();

    // Remove any existing listeners to avoid duplicates
    simulator.removeAllListeners('stateChanged');

    // Add listener to broadcast state changes
    simulator.on('stateChanged', (event) => {
      if (wsServer) {
        wsServer.broadcastStateUpdate(event.id, event.newState === 'TRUE');
      }
    });

    // Enable the simulator
    simulator.enable(intervalMs);

    console.log(`[SimulatorAPI] PLC Simulator enabled via API`);

    return NextResponse.json({
      success: true,
      message: 'PLC Simulator enabled',
      enabled: true,
      intervalMs,
      info: 'Simulator will randomly change I/O states for testing',
    });
  } catch (error) {
    console.error('[SimulatorAPI] Error enabling simulator:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
