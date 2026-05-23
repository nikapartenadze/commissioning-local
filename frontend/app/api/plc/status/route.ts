import { Request, Response } from 'express'
import { getPlcStatus, getPlcPerformanceStats } from '@/lib/plc-client-manager';
import {
  getAggregateStatus,
  getMcmStatus,
  hasAnyMcm,
  hasMcm,
} from '@/lib/mcm-registry';
import { configService } from '@/lib/config';
import { EMBEDDED_REMOTE_URL } from '@/lib/config/types';
import { db } from '@/lib/db-sqlite';

// Get testing state from shared global
const globalForTesting = globalThis as unknown as {
  isTestingUsers: Set<string> | undefined;
};

async function getLibraryStatus() {
  try {
    const plc = await import('@/lib/plc');
    return {
      loaded: plc.isLibraryLoaded(),
      path: plc.getLibraryPath(),
    };
  } catch (error) {
    return {
      loaded: false,
      path: null,
      error: error instanceof Error ? error.message : 'Library check failed',
    };
  }
}

export async function GET(req: Request, res: Response) {
  try {
    const config = await configService.getConfig();
    const libraryStatus = await getLibraryStatus();
    const performanceStats = getPlcPerformanceStats();

    // ?subsystemId=37 → scope status to that MCM. Default returns the
    // legacy aggregate so existing single-MCM consumers stay unchanged.
    const querySubsystemId =
      typeof req.query.subsystemId === 'string' ? req.query.subsystemId : undefined;

    if (querySubsystemId) {
      if (!hasMcm(querySubsystemId)) {
        return res.status(404).json({
          success: false,
          error: `MCM ${querySubsystemId} not configured or never connected`,
          subsystemId: querySubsystemId,
          connected: false,
          plcConnected: false,
          status: 'disconnected',
        });
      }
      const mcm = getMcmStatus(querySubsystemId)!;
      const ioCount = (db
        .prepare('SELECT COUNT(*) as count FROM Ios WHERE SubsystemId = ?')
        .get(parseInt(querySubsystemId, 10) || 0) as { count: number }).count;
      return res.json({
        success: true,
        subsystemId: querySubsystemId,
        connected: mcm.connected,
        plcConnected: mcm.connected,
        status: mcm.status,
        tagCount: mcm.tagCount,
        totalIos: ioCount,
        connectionConfig: { ip: mcm.ip, path: mcm.path },
        plcIp: mcm.ip,
        plcPath: mcm.path,
        apiPassword: config.apiPassword || '',
        remoteUrl: EMBEDDED_REMOTE_URL,
        performanceStats,
        library: libraryStatus,
        isTesting: (globalForTesting.isTestingUsers?.size ?? 0) > 0,
        isTestingUsers: Array.from(globalForTesting.isTestingUsers || []),
      });
    }

    // Aggregate path. When the registry has live MCMs, prefer it as the
    // source of truth so single-MCM consumers see the central-tool state.
    const status = getPlcStatus();
    const ioCount = (db.prepare('SELECT COUNT(*) as count FROM Ios').get() as { count: number }).count;

    let connected = status.connected;
    let statusStr = status.status;
    let tagCount = status.tagCount;
    let connectionConfig = status.connectionConfig
      ? { ip: status.connectionConfig.ip, path: status.connectionConfig.path }
      : null;
    let mcmSummary: ReturnType<typeof getAggregateStatus> | null = null;

    if (hasAnyMcm()) {
      mcmSummary = getAggregateStatus();
      connected = connected || mcmSummary.anyConnected;
      tagCount = Math.max(tagCount, mcmSummary.totalTagCount);
      if (!connectionConfig && mcmSummary.mcms.length > 0) {
        const first = mcmSummary.mcms.find((m) => m.connected) ?? mcmSummary.mcms[0];
        connectionConfig = { ip: first.ip, path: first.path };
      }
      statusStr = mcmSummary.anyConnected ? 'connected' : statusStr;
    }

    return res.json({
      success: true,
      connected,
      plcConnected: connected,
      status: statusStr,
      tagCount,
      totalIos: ioCount,
      connectionConfig,
      plcIp: connectionConfig?.ip || config.ip || '',
      plcPath: connectionConfig?.path || config.path || '1,0',
      subsystemId: config.subsystemId || '',
      apiPassword: config.apiPassword || '',
      remoteUrl: EMBEDDED_REMOTE_URL,
      plcProfiles: (config as any).plcProfiles || [],
      performanceStats,
      library: libraryStatus,
      isTesting: (globalForTesting.isTestingUsers?.size ?? 0) > 0,
      isTestingUsers: Array.from(globalForTesting.isTestingUsers || []),
      // Central-tool: per-MCM rollup so the UI can render a multi-station header.
      mcms: mcmSummary ? mcmSummary.mcms : undefined,
      connectedMcmCount: mcmSummary ? mcmSummary.connectedCount : undefined,
      totalMcmCount: mcmSummary ? mcmSummary.totalCount : undefined,
    });
  } catch (error) {
    console.error('PLC status error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      connected: false,
      plcConnected: false,
      status: 'error',
      tagCount: 0,
      totalIos: 0,
      plcIp: '',
      plcPath: '1,0',
      subsystemId: '',
      apiPassword: '',
      remoteUrl: '',
      isTesting: false,
      isTestingUsers: [],
    });
  }
}
