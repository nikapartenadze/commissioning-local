import { Request, Response } from 'express';
import { getMcmStatus } from '@/lib/mcm-registry';
import { configService } from '@/lib/config';
import { db } from '@/lib/db-sqlite';

/**
 * GET /api/mcm/:subsystemId/plc/status
 *
 * Per-MCM PLC connection status. Falls back to a 'never connected' shape if
 * the MCM is configured but the registry hasn't seen it yet.
 */
export async function GET(req: Request, res: Response) {
  const subsystemId = String(req.params.subsystemId);
  try {
    const cfg = await configService.getMcm(subsystemId);
    if (!cfg) {
      return res.status(404).json({ success: false, error: 'MCM not configured' });
    }

    const live = getMcmStatus(subsystemId);
    const ioCount = (db
      .prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ?')
      .get(parseInt(subsystemId, 10) || 0) as { count: number }).count;

    return res.json({
      success: true,
      subsystemId,
      name: cfg.name,
      connected: live?.connected ?? false,
      status: live?.status ?? 'disconnected',
      tagCount: live?.tagCount ?? 0,
      totalIos: ioCount,
      connectionConfig: live ? { ip: live.ip, path: live.path } : { ip: cfg.ip, path: cfg.path },
      plcIp: cfg.ip,
      plcPath: cfg.path,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      subsystemId,
      connected: false,
      status: 'error',
      tagCount: 0,
      totalIos: 0,
    });
  }
}
