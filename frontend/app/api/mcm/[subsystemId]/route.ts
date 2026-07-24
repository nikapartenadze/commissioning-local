import { Request, Response } from 'express';
import { configService } from '@/lib/config';
import { disposeMcm, getMcmStatus } from '@/lib/mcm-registry';
import { connectConfiguredMcm } from '@/lib/services/mcm-connect';

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

    const before = await configService.getMcm(subsystemId);
    const updated = await configService.updateMcm(subsystemId, patch);
    const updatedMcm = updated.find((m) => m.subsystemId === subsystemId);

    // Hot-reload the live registry entry. Persisting alone is not enough: a
    // registered client keeps its OLD ip/path (and its 5s auto-reconnect loop
    // keeps dialing the OLD address) until restart.
    let liveAction: 'reconnecting' | 'stale-entry-disposed' | undefined;
    const connChanged =
      before && updatedMcm && (updatedMcm.ip !== before.ip || updatedMcm.path !== before.path);
    if (connChanged) {
      const live = getMcmStatus(subsystemId);
      if (live?.connected) {
        // connectMcm() is idempotent — re-calling on a live entry updates the
        // stored config and reconnects. Fire-and-forget: a connect can take up
        // to 30s and the settings dialog must not hang on it.
        liveAction = 'reconnecting';
        console.log(
          `[MCM ${subsystemId}] ip/path changed while connected ` +
          `(${before.ip} path ${before.path} → ${updatedMcm.ip} path ${updatedMcm.path}) — reconnecting live entry`,
        );
        void connectConfiguredMcm(subsystemId).then((r) => {
          if (r.success) {
            console.log(`[MCM ${subsystemId}] Reconnected with new config — ${r.tagsSuccessful}/${r.totalTags} tags ok`);
          } else {
            console.warn(`[MCM ${subsystemId}] Reconnect with new config failed: ${r.error ?? 'unknown'}`);
          }
        });
      } else if (live) {
        // Registered but not connected: its auto-reconnect loop is still
        // chasing the OLD address. Tear the stale client down; do NOT connect
        // — the operator (or boot auto-connect) connects when ready.
        liveAction = 'stale-entry-disposed';
        console.log(
          `[MCM ${subsystemId}] ip/path changed while disconnected — disposed stale registry entry ` +
          `(was retrying ${before.ip} path ${before.path}); next connect uses ${updatedMcm.ip} path ${updatedMcm.path}`,
        );
        await disposeMcm(subsystemId);
      }
    }

    return res.json({ success: true, mcm: updatedMcm, ...(liveAction ? { liveAction } : {}) });
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
