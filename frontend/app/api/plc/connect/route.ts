import { Request, Response } from 'express'
import { connectPlc } from '@/lib/plc-client-manager';
import { configService } from '@/lib/config/config-service';

interface ConnectRequestBody {
  ip: string;
  path: string;
}

export async function POST(req: Request, res: Response) {
  try {
    const body: ConnectRequestBody = req.body;

    if (!body.ip || typeof body.ip !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid "ip" field' });
    }

    if (!body.path || typeof body.path !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid "path" field' });
    }

    // ── Multi-MCM fence ─────────────────────────────────────────────────
    // When config.json explicitly lists MCMs, PLC connections are owned by
    // the per-MCM registry (each MCM dials its OWN ip/path). This legacy
    // route drives the unscoped singleton — on a central box it opens a
    // second, divergent connection with no subsystem attribution (same
    // class as the boot-autoconnect MCM17 flap). Refuse and point at the
    // scoped connect. Single-MCM tablets (no mcms[] in config) fall through
    // unchanged.
    {
      const cfg = await configService.getConfig();
      if (cfg.mcmsExplicit) {
        return res.status(409).json({
          success: false,
          error:
            `Legacy PLC connect refused: this is a multi-MCM deployment (${cfg.mcms?.length ?? 0} MCM(s) configured). ` +
            'This route drives the unscoped singleton client. Use the per-MCM connect ' +
            '(POST /api/mcm/:subsystemId/plc/connect) instead.',
        });
      }
    }

    console.log(`Connecting to PLC at ${body.ip} with path ${body.path}`);

    const result = await connectPlc({ ip: body.ip, path: body.path });

    if (result.success) {
      return res.json({
        success: true,
        message: `Connected to PLC at ${body.ip}`,
        status: result.status,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to connect to PLC',
        status: result.status,
      });
    }
  } catch (error) {
    console.error('PLC connect error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
