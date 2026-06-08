import { Request, Response } from 'express';
import { connectConfiguredMcm } from '@/lib/services/mcm-connect';

/**
 * POST /api/mcm/:subsystemId/plc/connect
 *
 * Pull-then-connect for one MCM. Delegates to connectConfiguredMcm with
 * ensureIos:true so pressing "Connect" on a freshly-imported station (IP set,
 * no IOs yet) automatically pulls its IO definitions from the cloud and THEN
 * connects the PLC — no separate "Pull IOs" step. The auto-pull goes through
 * the guarded scoped endpoint (POST /api/mcm/:id/pull), so it inherits the
 * unsynced-data protection: a re-pull that would erase pending field results
 * is refused. (A station with no IOs has nothing pending, so first-connect is
 * never blocked.)
 *
 * Body (optional): { ip?, path? } — overrides stored config for this call.
 */
export async function POST(req: Request, res: Response) {
  const subsystemId = String(req.params.subsystemId);
  const body = req.body ?? {};
  const ip = body.ip !== undefined ? String(body.ip).trim() : undefined;
  const path = body.path !== undefined ? String(body.path).trim() : undefined;

  try {
    const r = await connectConfiguredMcm(subsystemId, { ip, path }, { ensureIos: true });

    // Map the shared result to this route's response shape (kept stable for
    // the central dashboard + commissioning page clients).
    const status = r.success ? 200 : (r.skipped ? 400 : 200);
    return res.status(status).json({
      success: r.success,
      message: r.success ? `MCM ${subsystemId} connected` : undefined,
      error: r.success ? undefined : (r.error || 'Failed to connect to PLC'),
      status: r.status,
      plcReachable: r.plcReachable ?? false,
      totalTags: r.totalTags ?? 0,
      tagsSuccessful: r.tagsSuccessful ?? 0,
      tagsFailed: r.tagsFailed ?? 0,
      pulledIos: r.pulledIos,
      warning:
        r.success && (r.tagsFailed ?? 0) > 0
          ? `${r.tagsFailed} of ${r.totalTags} IO tags failed — names may not match PLC program`
          : (r.success && r.pulledIos ? `Pulled ${r.pulledIos} IOs from cloud, then connected` : undefined),
    });
  } catch (error) {
    console.error(`[MCM ${subsystemId}] Connect error:`, error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to PLC',
    });
  }
}
