export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getPlcStatus, getPlcPerformanceStats } from '@/lib/plc-client-manager';
import { configService } from '@/lib/config';
import { db } from '@/lib/db-sqlite';

// Get testing state from shared global
const globalForTesting = globalThis as unknown as {
  isTestingUsers: Set<string> | undefined;
};

// Try to get library status safely
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

export async function GET() {
  try {
    const status = getPlcStatus();
    const performanceStats = getPlcPerformanceStats();
    const config = await configService.getConfig();
    const ioCount = (db.prepare('SELECT COUNT(*) as count FROM Ios').get() as { count: number }).count;
    const libraryStatus = await getLibraryStatus();

    return NextResponse.json({
      success: true,
      connected: status.connected,
      plcConnected: status.connected,
      status: status.status,
      tagCount: status.tagCount,
      totalIos: ioCount,
      connectionConfig: status.connectionConfig
        ? {
            ip: status.connectionConfig.ip,
            path: status.connectionConfig.path,
          }
        : null,
      // Add fields expected by plc-config-dialog
      plcIp: status.connectionConfig?.ip || config.ip || '',
      plcPath: status.connectionConfig?.path || config.path || '1,0',
      subsystemId: config.subsystemId || '',
      apiPassword: config.apiPassword || '',
      remoteUrl: config.remoteUrl || 'https://commissioning.lci.ge',
      plcProfiles: (config as any).plcProfiles || [],
      performanceStats,
      library: libraryStatus,
      isTesting: (globalForTesting.isTestingUsers?.size ?? 0) > 0,
      isTestingUsers: Array.from(globalForTesting.isTestingUsers || []),
    });
  } catch (error) {
    console.error('PLC status error:', error);
    return NextResponse.json(
      {
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
      },
      { status: 500 }
    );
  }
}
