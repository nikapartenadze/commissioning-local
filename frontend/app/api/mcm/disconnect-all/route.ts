import { Request, Response } from 'express';
import { configService } from '@/lib/config';
import { disconnectMcm, getMcmStatus } from '@/lib/mcm-registry';

/**
 * POST /api/mcm/disconnect-all
 *
 * Disconnect every enabled MCM that is currently connected, in parallel. Each
 * reports its own outcome (disconnected / skipped-not-connected / failed) so the
 * UI can show "X disconnected, Y skipped".
 */
export async function POST(_req: Request, res: Response) {
  try {
    const mcms = (await configService.getMcms()).filter((m) => m.enabled !== false);

    const results = await Promise.all(
      mcms.map(async (m) => {
        const status = getMcmStatus(m.subsystemId);
        if (!status || !status.connected) {
          return { subsystemId: m.subsystemId, name: m.name, success: true, skipped: true };
        }
        try {
          await disconnectMcm(m.subsystemId);
          return { subsystemId: m.subsystemId, name: m.name, success: true };
        } catch (error) {
          return {
            subsystemId: m.subsystemId,
            name: m.name,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    const disconnected = results.filter((r) => r.success && !r.skipped).length;
    const failed = results.filter((r) => !r.success).length;
    const skipped = results.filter((r) => r.skipped).length;

    return res.json({ success: true, total: results.length, disconnected, failed, skipped, results });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'disconnect-all failed',
    });
  }
}
