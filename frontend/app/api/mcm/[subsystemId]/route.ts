import { Request, Response } from 'express';
import { configService } from '@/lib/config';
import { disposeMcm, getMcmStatus } from '@/lib/mcm-registry';

/**
 * GET /api/mcm/:subsystemId
 *
 * One MCM's config + live status.
 */
export async function GET(req: Request, res: Response) {
  const subsystemId = String(req.params.subsystemId);
  try {
    const cfg = await configService.getMcm(subsystemId);
    if (!cfg) {
      return res.status(404).json({ success: false, error: 'MCM not configured' });
    }
    const live = getMcmStatus(subsystemId);
    return res.json({
      success: true,
      mcm: {
        subsystemId: cfg.subsystemId,
        name: cfg.name,
        ip: cfg.ip,
        path: cfg.path,
        enabled: cfg.enabled !== false,
        connected: live?.connected ?? false,
        status: live?.status ?? 'disconnected',
        tagCount: live?.tagCount ?? 0,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}

/**
 * PUT /api/mcm/:subsystemId
 *
 * Update name / ip / path / enabled. subsystemId is immutable.
 * Body: Partial<{ name, ip, path, enabled }>
 */
export async function PUT(req: Request, res: Response) {
  const subsystemId = String(req.params.subsystemId);
  try {
    const body = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.ip === 'string') patch.ip = body.ip.trim();
    if (typeof body.path === 'string') patch.path = body.path.trim();
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

    const updated = await configService.updateMcm(subsystemId, patch);
    const updatedMcm = updated.find((m) => m.subsystemId === subsystemId);
    return res.json({ success: true, mcm: updatedMcm });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    const status = message.includes('not found') ? 404 : 500;
    return res.status(status).json({ success: false, error: message });
  }
}

/**
 * DELETE /api/mcm/:subsystemId
 *
 * Remove the MCM from config and tear down its live client if any.
 */
export async function DELETE(req: Request, res: Response) {
  const subsystemId = String(req.params.subsystemId);
  try {
    await disposeMcm(subsystemId);
    const updated = await configService.removeMcm(subsystemId);
    return res.json({ success: true, mcms: updated, count: updated.length });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
