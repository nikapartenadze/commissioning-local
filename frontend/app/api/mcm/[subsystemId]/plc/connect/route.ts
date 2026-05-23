import { Request, Response } from 'express';
import { configService } from '@/lib/config';
import { connectMcm, loadMcmTags } from '@/lib/mcm-registry';
import { db } from '@/lib/db-sqlite';

interface IoRow {
  id: number;
  Name: string | null;
  Description: string | null;
  TagType: string | null;
}

const CONNECT_TIMEOUT_MS = 30_000;

/**
 * POST /api/mcm/:subsystemId/plc/connect
 *
 * Loads the IO tag set for this subsystem from SQLite, then connects the
 * libplctag client. Independent of every other MCM in the registry —
 * connecting one does not touch the others.
 *
 * Body (optional): { ip?, path? } — overrides stored config for this call.
 */
export async function POST(req: Request, res: Response) {
  const subsystemId = String(req.params.subsystemId);
  try {
    const cfg = await configService.getMcm(subsystemId);
    if (!cfg) {
      return res.status(404).json({ success: false, error: 'MCM not configured' });
    }

    const body = req.body ?? {};
    const ip = String(body.ip ?? cfg.ip ?? '').trim();
    const path = String(body.path ?? cfg.path ?? '1,0').trim();
    if (!ip) {
      return res.status(400).json({ success: false, error: 'ip is required' });
    }

    // Load IO tags for this subsystem only — multi-MCM isolation.
    const subsystemIdNum = parseInt(subsystemId, 10);
    if (!Number.isFinite(subsystemIdNum)) {
      return res.status(400).json({ success: false, error: 'subsystemId must be numeric' });
    }
    const ios = db
      .prepare('SELECT id, Name, Description, TagType FROM Ios WHERE SubsystemId = ?')
      .all(subsystemIdNum) as IoRow[];

    if (ios.length === 0) {
      return res.status(400).json({
        success: false,
        error: `No IOs in database for subsystem ${subsystemId} — pull IOs from cloud first`,
      });
    }

    const tags = ios.map((io) => ({
      id: io.id,
      name: io.Name || '',
      description: io.Description || undefined,
      tagType: io.TagType || undefined,
    }));
    loadMcmTags(subsystemId, tags);

    console.log(
      `[MCM ${subsystemId}] Connecting to PLC ${ip} path=${path}, ${tags.length} tags queued`
    );

    let result: Awaited<ReturnType<typeof connectMcm>>;
    try {
      result = await Promise.race([
        connectMcm(subsystemId, cfg.name, { ip, path }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`PLC connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
            CONNECT_TIMEOUT_MS
          )
        ),
      ]);
    } catch (timeoutError) {
      console.error(`[MCM ${subsystemId}] Connect timeout:`, timeoutError);
      return res.status(504).json({
        success: false,
        error: timeoutError instanceof Error ? timeoutError.message : 'Connection timed out',
      });
    }

    // Persist the (possibly new) ip/path back to config so the next session
    // reconnects with the same values.
    if (ip !== cfg.ip || path !== cfg.path) {
      try {
        await configService.updateMcm(subsystemId, { ip, path });
      } catch (e) {
        console.warn(`[MCM ${subsystemId}] Could not persist updated ip/path:`, e);
      }
    }

    const rawFailedTags = result.failedTags || [];
    const tagReport = {
      plcIp: ip,
      plcPath: path,
      plcReachable: result.plcReachable ?? false,
      timestamp: new Date().toISOString(),
      totalTags: ios.length,
      tagsSuccessful: result.tagsSuccessful || 0,
      tagsFailed: rawFailedTags.length,
      failedTags: rawFailedTags.slice(0, 100),
    };

    if (!result.success) {
      console.warn(`[MCM ${subsystemId}] PLC connection failed: ${result.error}`);
      return res.json({
        success: false,
        error: result.error || 'Failed to connect to PLC',
        status: result.status,
        ...tagReport,
      });
    }

    console.log(
      `[MCM ${subsystemId}] PLC connected — ${tagReport.tagsSuccessful} ok, ${tagReport.tagsFailed} failed`
    );
    return res.json({
      success: true,
      message: `MCM ${subsystemId} connected`,
      status: result.status,
      ...tagReport,
      warning:
        tagReport.tagsFailed > 0
          ? `${tagReport.tagsFailed} of ${tagReport.totalTags} IO tags failed — names may not match PLC program`
          : undefined,
    });
  } catch (error) {
    console.error(`[MCM ${subsystemId}] Connect error:`, error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to connect to PLC',
    });
  }
}
