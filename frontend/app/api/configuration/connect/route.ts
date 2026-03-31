export const dynamic = 'force-dynamic';

/**
 * PLC Connect API Route
 *
 * POST: Connect to PLC with provided configuration
 * Uses Node.js libplctag bindings - no C# backend required
 */

import { NextRequest, NextResponse } from 'next/server';
import { configService } from '@/lib/config/config-service';
import { requireAuth } from '@/lib/auth/middleware';
import { PlcConnectRequest } from '@/lib/config/types';
import { connectPlc, loadPlcTags, getPlcClient, getWsBroadcastUrl } from '@/lib/plc-client-manager';
import { isLibraryLoaded, getLibraryPath } from '@/lib/plc';
import { prisma } from '@/lib/db';

/**
 * POST /api/configuration/connect
 * Connect to PLC with provided IP and path configuration.
 * Updates config and connects using Node.js libplctag bindings.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request)
  if (authError) return authError

  try {
    const body = await request.json() as PlcConnectRequest;

    // Validate required fields
    if (!body.ip) {
      return NextResponse.json(
        { error: 'IP address is required' },
        { status: 400 }
      );
    }

    if (!body.path) {
      return NextResponse.json(
        { error: 'Path is required' },
        { status: 400 }
      );
    }

    console.log('[Connect API] Starting PLC connection:', { ip: body.ip, path: body.path });

    // Ensure library is loaded by getting client (triggers init)
    try {
      getPlcClient();
      console.log('[Connect API] libplctag library status:', {
        loaded: isLibraryLoaded(),
        path: getLibraryPath(),
      });
    } catch (libError) {
      console.error('[Connect API] Failed to initialize libplctag:', libError);
      return NextResponse.json(
        { error: `Failed to load libplctag: ${libError instanceof Error ? libError.message : String(libError)}` },
        { status: 500 }
      );
    }

    // Get current config for defaults
    const currentConfig = await configService.getConfig();

    // Update local config
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

    // Load IO tags from database into PLC client FIRST (before connecting)
    const ios = await prisma.io.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        tagType: true,
      }
    });

    if (ios.length > 0) {
      const tags = ios.map(io => ({
        id: io.id,
        name: io.name || '',
        description: io.description || undefined,
        tagType: io.tagType || undefined,
      }));

      loadPlcTags(tags);
      console.log(`[Connect API] Loaded ${tags.length} IO tags into PLC client`);
      console.log('[Connect API] Sample tag names:', tags.slice(0, 5).map(t => t.name));
    } else {
      console.log('[Connect API] No IOs found in database - pull IOs from cloud first');
      return NextResponse.json(
        { error: 'No IOs in database - pull IOs from cloud first' },
        { status: 400 }
      );
    }

    // Connect to PLC using Node.js libplctag (tags must be loaded first)
    // Add overall timeout to prevent hanging
    const CONNECT_TIMEOUT_MS = 30000; // 30 seconds max for entire connection

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
      return NextResponse.json(
        { error: timeoutError instanceof Error ? timeoutError.message : 'Connection timed out' },
        { status: 504 }
      );
    }

    // Build tag report (IO tags only)
    const rawFailedTags = connectResult.failedTags || [];
    const ioLookup = new Map(ios.map(io => [io.name || '', io.description || '']));
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
      return NextResponse.json({
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

    // Broadcast PLC connection to all WebSocket clients
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

    // Trigger network + estop tag creation in background (don't block response)
    // This ensures cloud push has real values even before those pages are opened
    setTimeout(async () => {
      try {
        const port = process.env.PORT || '3000'
        await fetch(`http://localhost:${port}/api/network/status?subsystemId=${config?.subsystemId || ''}`)
        await fetch(`http://localhost:${port}/api/estop/status`)
        console.log('[Connect API] Network + EStop tag handles created in background')
      } catch {}
    }, 5000)

    return NextResponse.json({
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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to connect to PLC' },
      { status: 500 }
    );
  }
}
