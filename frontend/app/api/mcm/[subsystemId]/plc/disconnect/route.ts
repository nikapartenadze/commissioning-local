import { Request, Response } from 'express';
import { disconnectMcm, hasMcm } from '@/lib/mcm-registry';
import { auditLog } from '@/lib/logging/recovery-log';

/**
 * POST /api/mcm/:subsystemId/plc/disconnect
 *
 * Tear down the per-MCM client and its network poller. No-op if the MCM has
 * never been connected.
 */
export async function POST(req: Request, res: Response) {
  const subsystemId = String(req.params.subsystemId);
  try {
    if (!hasMcm(subsystemId)) {
      return res.json({ success: true, status: 'disconnected', alreadyDown: true });
    }
    await disconnectMcm(subsystemId);
    // Durable recovery-log trace of the teardown. Log-only.
    auditLog({ type: 'plc.disconnect', subsystemId });
    return res.json({ success: true, status: 'disconnected' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
