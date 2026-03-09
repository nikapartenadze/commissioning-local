import { NextResponse } from 'next/server';
import { getPlcSimulator, hasPlcSimulator } from '@/lib/services/plc-simulator-service';

/**
 * POST /api/simulator/disable
 *
 * Disable the PLC simulator.
 */
export async function POST() {
  try {
    if (!hasPlcSimulator()) {
      return NextResponse.json({
        success: true,
        message: 'PLC Simulator was not running',
        enabled: false,
      });
    }

    const simulator = getPlcSimulator();

    // Disable the simulator
    simulator.disable();

    // Remove event listeners
    simulator.removeAllListeners('stateChanged');

    console.log('[SimulatorAPI] PLC Simulator disabled via API');

    return NextResponse.json({
      success: true,
      message: 'PLC Simulator disabled',
      enabled: false,
    });
  } catch (error) {
    console.error('[SimulatorAPI] Error disabling simulator:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
