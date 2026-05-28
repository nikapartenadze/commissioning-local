import { Request, Response } from 'express'
import { getPlcStatus, getPlcPerformanceStats } from '@/lib/plc-client-manager';
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
    const status = getPlcStatus();
    const performanceStats = getPlcPerformanceStats();
    const config = await configService.getConfig();
    const ioCount = (db.prepare('SELECT COUNT(*) as count FROM Ios').get() as { count: number }).count;
    const libraryStatus = await getLibraryStatus();

    // Derived: are we actively trying to reconnect right now? Mirrors the
    // logic at plc-client-manager.ts:164 where the WebSocket broadcast is
    // computed. The UI uses this as the AUTHORITATIVE answer to fix the
    // "Connection Lost — Reconnecting" banner getting stuck when a
    // NetworkStatusChanged WebSocket event is missed or arrives stale —
    // the page polls this endpoint every ~20 s and reconciles its local
    // banner state to the server's canonical view.
    const isReconnecting = status.status === 'error' && status.connectionConfig !== null;

    return res.json({
      success: true,
      connected: status.connected,
      plcConnected: status.connected,
      isReconnecting,
      status: status.status,
      tagCount: status.tagCount,
      totalIos: ioCount,
      connectionConfig: status.connectionConfig
        ? {
            ip: status.connectionConfig.ip,
            path: status.connectionConfig.path,
          }
        : null,
      plcIp: status.connectionConfig?.ip || config.ip || '',
      plcPath: status.connectionConfig?.path || config.path || '1,0',
      subsystemId: config.subsystemId || '',
      apiPassword: config.apiPassword || '',
      remoteUrl: EMBEDDED_REMOTE_URL,
      plcProfiles: (config as any).plcProfiles || [],
      performanceStats,
      library: libraryStatus,
      isTesting: (globalForTesting.isTestingUsers?.size ?? 0) > 0,
      isTestingUsers: Array.from(globalForTesting.isTestingUsers || []),
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
