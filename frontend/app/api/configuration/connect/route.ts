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

    let networkTags: Array<{ id: number; name: string; description?: string; tagType?: string }> = [];

    if (ios.length > 0) {
      const tags = ios.map(io => ({
        id: io.id,
        name: io.name || '',
        description: io.description || undefined,
        tagType: io.tagType || undefined,
      }));

      // Also load network status tags (ConnectionFaulted) so they're polled in the same loop
      try {
        const rings = await prisma.networkRing.findMany({
          include: { nodes: { include: { ports: true } } },
        });
        let netId = -1; // Negative IDs to avoid collision with real IO IDs
        for (const ring of rings) {
          if (ring.mcmTag) {
            networkTags.push({ id: netId--, name: ring.mcmTag, description: `MCM ${ring.mcmName} status`, tagType: 'network_status' });
          }
          for (const node of ring.nodes) {
            if (node.statusTag) {
              networkTags.push({ id: netId--, name: node.statusTag, description: `DPM ${node.name} status`, tagType: 'network_status' });
            }
            for (const port of node.ports) {
              if (port.statusTag) {
                networkTags.push({ id: netId--, name: port.statusTag, description: `${port.deviceName || 'Device'} status`, tagType: 'network_status' });
              }
            }
          }
        }
      } catch (e) {
        console.log('[Connect API] No network topology data to load status tags');
      }

      // Also load EStop tags (checkTag, ioPoint tags, VFD STO tags) so they're polled in the same loop
      const estopTags: typeof networkTags = [];
      try {
        const zones = await (prisma as any).eStopZone.findMany({
          include: { epcs: { include: { ioPoints: true, vfds: true } } },
        });
        let estopId = -10000; // Negative IDs well below network range
        for (const zone of zones) {
          for (const epc of zone.epcs) {
            if (epc.checkTag) {
              estopTags.push({ id: estopId--, name: epc.checkTag, description: `EPC ${epc.name} check`, tagType: 'estop_status' });
            }
            for (const io of epc.ioPoints) {
              if (io.tag) {
                estopTags.push({ id: estopId--, name: io.tag, description: `EPC ${epc.name} IO point`, tagType: 'estop_status' });
              }
            }
            for (const vfd of epc.vfds) {
              if (vfd.stoTag) {
                estopTags.push({ id: estopId--, name: vfd.stoTag, description: `VFD ${vfd.tag} STO`, tagType: 'estop_status' });
              }
            }
          }
        }
      } catch (e) {
        console.log('[Connect API] No EStop data to load status tags');
      }

      const allTags = [...tags, ...networkTags, ...estopTags];
      loadPlcTags(allTags);
      console.log(`[Connect API] Loaded ${tags.length} IO tags + ${networkTags.length} network tags + ${estopTags.length} estop tags into PLC client`);
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

    // Build tag report — separate IO, network, and estop tags
    const rawFailedTags = connectResult.failedTags || [];
    const networkTagNames = new Set(networkTags.map(t => t.name));
    const estopTagNames = new Set(estopTags.map(t => t.name));

    const ioFailedTags = rawFailedTags.filter(t => !networkTagNames.has(t.name) && !estopTagNames.has(t.name));
    const networkFailedTags = rawFailedTags.filter(t => networkTagNames.has(t.name));
    const estopFailedTags = rawFailedTags.filter(t => estopTagNames.has(t.name));

    const ioLookup = new Map(ios.map(io => [io.name || '', io.description || '']));
    const failedTags = ioFailedTags.map(t => ({
      name: t.name,
      description: ioLookup.get(t.name) || '',
      error: t.error,
    }));

    const plcReachable = connectResult.plcReachable ?? false;
    const nonIoSuccessful = (networkTags.length - networkFailedTags.length) + (estopTags.length - estopFailedTags.length);
    const ioTagsSuccessful = (connectResult.tagsSuccessful || 0) - nonIoSuccessful;
    const tagReport = {
      plcIp: body.ip,
      plcPath: body.path,
      plcReachable,
      timestamp: new Date().toISOString(),
      totalTags: ios.length,
      tagsSuccessful: Math.max(0, ioTagsSuccessful),
      tagsFailed: ioFailedTags.length,
      failedTags: failedTags.slice(0, 100),
      // Network stats
      networkTotalTags: networkTags.length,
      networkSuccessful: networkTags.length - networkFailedTags.length,
      networkFailed: networkFailedTags.length,
      // EStop stats
      estopTotalTags: estopTags.length,
      estopSuccessful: estopTags.length - estopFailedTags.length,
      estopFailed: estopFailedTags.length,
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
