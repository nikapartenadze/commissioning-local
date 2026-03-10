import { NextRequest, NextResponse } from 'next/server';
import { getPlcSimulator } from '@/lib/services/plc-simulator-service';
import { getWsBroadcastUrl } from '@/lib/plc-client-manager';

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

    simulator.removeAllListeners('stateChanged');

    simulator.on('stateChanged', (event) => {
      fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'UpdateState',
          id: event.id,
          state: event.newState === 'TRUE',
        }),
      }).catch(() => {});
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
