import { NextResponse } from 'next/server';
import { getPlcSimulator, hasPlcSimulator } from '@/lib/services/plc-simulator-service';

/**
 * GET /api/simulator/status
 *
 * Get the current status of the PLC simulator.
 *
 * Response:
 * - enabled: boolean - Whether the simulator is currently running
 * - intervalMs: number - The update interval in milliseconds
 * - ioCount: number - Number of loaded IOs
 * - untestedCount: number - Number of untested IOs remaining
 * - message: string - Human-readable status message
 */
export async function GET() {
  try {
    if (!hasPlcSimulator()) {
      return NextResponse.json({
        success: true,
        enabled: false,
        intervalMs: 2000,
        ioCount: 0,
        untestedCount: 0,
        message: 'Simulator is not initialized',
      });
    }

    const simulator = getPlcSimulator();
    const status = simulator.getStatus();

    return NextResponse.json({
      success: true,
      enabled: status.enabled,
      intervalMs: status.intervalMs,
      ioCount: status.ioCount,
      untestedCount: status.untestedCount,
      message: status.enabled ? 'Simulator is running' : 'Simulator is stopped',
    });
  } catch (error) {
    console.error('[SimulatorAPI] Error getting simulator status:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}
