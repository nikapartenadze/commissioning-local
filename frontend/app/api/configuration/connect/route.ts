import { Request, Response } from 'express'
import { configService } from '@/lib/config/config-service';
import { PlcConnectRequest } from '@/lib/config/types';
import { connectPlc, loadPlcTags, getPlcClient, getWsBroadcastUrl } from '@/lib/plc-client-manager';
import { isLibraryLoaded, getLibraryPath } from '@/lib/plc';
import { db } from '@/lib/db-sqlite';

interface IoRow {
  id: number;
  Name: string | null;
  Description: string | null;
  TagType: string | null;
}

/**
 * POST /api/configuration/connect
 */
export async function POST(req: Request, res: Response) {
  try {
    const body = req.body as PlcConnectRequest;

    if (!body.ip) {
      return res.status(400).json({ error: 'IP address is required' });
    }

    if (!body.path) {
      return res.status(400).json({ error: 'Path is required' });
    }

    console.log('[Connect API] Starting PLC connection:', { ip: body.ip, path: body.path });

    try {
      getPlcClient();
      console.log('[Connect API] libplctag library status:', {
        loaded: isLibraryLoaded(),
        path: getLibraryPath(),
      });
    } catch (libError) {
      console.error('[Connect API] Failed to initialize libplctag:', libError);
      return res.status(500).json({
        error: `Failed to load libplctag: ${libError instanceof Error ? libError.message : String(libError)}`
      });
    }

    const currentConfig = await configService.getConfig();

    await configService.saveConfig({
      ip: body.ip,
      path: body.path,
      subsystemId: body.subsystemId ?? currentConfig.subsystemId,
      remoteUrl: body.remoteUrl ?? currentConfig.remoteUrl,
      apiPassword: body.apiPassword ?? currentConfig.apiPassword,
      orderMode: body.orderMode !== undefined
        ? (body.orderMode ? '1' : '0')
        : currentConfig.orderMode,
      showStateColumn: body.showStateColumn ?? currentConfig.showStateColumn,
      showResultColumn: body.showResultColumn ?? currentConfig.showResultColumn,
      showTimestampColumn: body.showTimestampColumn ?? currentConfig.showTimestampColumn,
      showHistoryColumn: body.showHistoryColumn ?? currentConfig.showHistoryColumn,
    });

    const ios = db.prepare(
      'SELECT id, Name, Description, TagType FROM Ios'
    ).all() as IoRow[];

    if (ios.length > 0) {
      const tags = ios.map(io => ({
        id: io.id,
        name: io.Name || '',
        description: io.Description || undefined,
        tagType: io.TagType || undefined,
      }));

      loadPlcTags(tags);
      console.log(`[Connect API] Loaded ${tags.length} IO tags into PLC client`);
      console.log('[Connect API] Sample tag names:', tags.slice(0, 5).map(t => t.name));
    } else {
      console.log('[Connect API] No IOs found in database - pull IOs from cloud first');
      return res.status(400).json({ error: 'No IOs in database - pull IOs from cloud first' });
    }

    const CONNECT_TIMEOUT_MS = 30000;

    let connectResult: Awaited<ReturnType<typeof connectPlc>>;
    try {
      connectResult = await Promise.race([
        connectPlc({
          ip: body.ip,
          path: body.path,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PLC connection timed out after 30 seconds')), CONNECT_TIMEOUT_MS)
        )
      ]);
    } catch (timeoutError) {
      console.error('[Connect API] PLC connection timeout:', timeoutError);
      return res.status(504).json({
        error: timeoutError instanceof Error ? timeoutError.message : 'Connection timed out'
      });
    }

    const rawFailedTags = connectResult.failedTags || [];
    const ioLookup = new Map(ios.map(io => [io.Name || '', io.Description || '']));
    const failedTags = rawFailedTags.map(t => ({
      name: t.name,
      description: ioLookup.get(t.name) || '',
      error: t.error,
    }));

    const plcReachable = connectResult.plcReachable ?? false;
    console.log(`[Connect API] Tag report: ${connectResult.tagsSuccessful || 0} successful, ${rawFailedTags.length} failed`);

    const tagReport = {
      plcIp: body.ip,
      plcPath: body.path,
      plcReachable,
      timestamp: new Date().toISOString(),
      totalTags: ios.length,
      tagsSuccessful: connectResult.tagsSuccessful || 0,
      tagsFailed: rawFailedTags.length,
      failedTags: failedTags.slice(0, 100),
    };

    if (!connectResult.success) {
      console.warn('[Connect API] PLC connection issue:', connectResult.error, '| PLC reachable:', plcReachable);
      return res.json({
        success: false,
        error: connectResult.error || 'Failed to connect to PLC',
        ...tagReport,
      });
    }

    console.log('[Connect API] PLC connection successful:', {
      ip: body.ip,
      path: body.path,
      status: connectResult.status,
      tagsSuccessful: tagReport.tagsSuccessful,
      tagsFailed: tagReport.tagsFailed,
    });

    try {
      await fetch(getWsBroadcastUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'PlcConnectionChanged',
          connected: true,
        })
      });
    } catch {
      // WebSocket server might not be running
    }

    setTimeout(async () => {
      try {
        const port = process.env.PORT || '3000'
        await fetch(`http://localhost:${port}/api/network/status?subsystemId=${body.subsystemId || ''}`)
        await fetch(`http://localhost:${port}/api/estop/status`)
        console.log('[Connect API] Network + EStop tag handles created in background')
      } catch (e) { console.warn('[Connect API] Background network/estop status fetch failed:', e) }
    }, 5000)

    return res.json({
      success: true,
      message: 'PLC connected',
      status: connectResult.status,
      ...tagReport,
      warning: tagReport.tagsFailed > 0
        ? `${tagReport.tagsFailed} of ${tagReport.totalTags} IO tags failed — names may not match PLC program`
        : undefined,
    });
  } catch (error) {
    console.error('[Connect API] Error connecting to PLC:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to connect to PLC'
    });
  }
}
