import { Request, Response } from 'express';
import { configService } from '@/lib/config';
import { connectConfiguredMcm, type ConnectMcmResult } from '@/lib/services/mcm-connect';

/**
 * POST /api/mcm/connect-all
 *
 * Connect every enabled, configured MCM in parallel. Partial success is the
 * norm: each MCM reports its own outcome (connected / failed / skipped-no-IP)
 * with a reason, so the UI can show "X connected, Y failed" and list why.
 */
export async function POST(_req: Request, res: Response) {
  try {
    const mcms = (await configService.getMcms()).filter((m) => m.enabled !== false);

    const results: ConnectMcmResult[] = await Promise.all(
      mcms.map((m) => connectConfiguredMcm(m.subsystemId))
    );

    const connected = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;

    return res.json({
      success: true,
      total: results.length,
      connected,
      failed,
      skipped,
      results,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'connect-all failed',
    });
  }
}
