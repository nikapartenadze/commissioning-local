import { Request, Response } from 'express';
import { configService } from '@/lib/config';
import { listMcms } from '@/lib/mcm-registry';

/**
 * GET /api/mcm
 *
 * Returns every configured MCM merged with its live connection status from
 * the registry. Configured MCMs that haven't been connected yet appear with
 * connected=false / status='disconnected' / tagCount=0.
 */
export async function GET(_req: Request, res: Response) {
  try {
    const configured = await configService.getMcms();
    const live = new Map(listMcms().map((m) => [m.subsystemId, m]));

    const merged = configured.map((cfg) => {
      const status = live.get(cfg.subsystemId);
      return {
        subsystemId: cfg.subsystemId,
        name: cfg.name,
        ip: cfg.ip,
        path: cfg.path,
        enabled: cfg.enabled !== false,
        connected: status?.connected ?? false,
        status: status?.status ?? 'disconnected',
        tagCount: status?.tagCount ?? 0,
      };
    });

    return res.json({ success: true, mcms: merged, count: merged.length });
  } catch (error) {
    console.error('[MCM list] Error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      mcms: [],
      count: 0,
    });
  }
}

/**
 * POST /api/mcm
 *
 * Add a new MCM entry. Body: { subsystemId, name, ip, path, enabled? }
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = req.body ?? {};
    const subsystemId = String(body.subsystemId ?? '').trim();
    const name = String(body.name ?? '').trim() || `MCM ${subsystemId}`;
    const ip = String(body.ip ?? '').trim();
    const path = String(body.path ?? '1,0').trim();

    if (!subsystemId) {
      return res.status(400).json({ success: false, error: 'subsystemId is required' });
    }
    if (!ip) {
      return res.status(400).json({ success: false, error: 'ip is required' });
    }

    const updated = await configService.addMcm({
      subsystemId,
      name,
      ip,
      path,
      enabled: body.enabled !== false,
    });
    return res.json({ success: true, mcms: updated, count: updated.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    const status = message.includes('already exists') ? 409 : 500;
    return res.status(status).json({ success: false, error: message });
  }
}
