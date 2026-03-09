import { NextResponse } from 'next/server';
import { getPlcTags, getPlcStatus } from '@/lib/plc-client-manager';
import { configService } from '@/lib/config';

export async function GET() {
  try {
    const status = getPlcStatus();
    const tagsResult = getPlcTags();
    const config = await configService.loadConfig();

    const totalTags = tagsResult.count || 0;
    const successfulTags = totalTags; // All loaded tags are considered successful for now
    const failedTags = 0;
    const successRate = totalTags > 0 ? 100 : 0;

    // Return format compatible with TagStatusDialog
    return NextResponse.json({
      // Original format
      success: true,
      connected: status.connected,
      status: status.status,
      tags: tagsResult.tags,
      count: tagsResult.count,
      // TagStatus format for dialog
      plcConnected: status.connected,
      totalTags,
      successfulTags,
      failedTags,
      successRate,
      hasErrors: failedTags > 0,
      notFoundTags: [],
      illegalTags: [],
      unknownErrorTags: [],
      dintGroupFailures: [],
      lastUpdated: new Date().toISOString(),
      plcIp: config.ip || '',
      plcPath: config.path || '1,0',
    });
  } catch (error) {
    console.error('PLC tags error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
        tags: [],
        count: 0,
        plcConnected: false,
        totalTags: 0,
        successfulTags: 0,
        failedTags: 0,
        successRate: 0,
        hasErrors: false,
        notFoundTags: [],
        illegalTags: [],
        unknownErrorTags: [],
        dintGroupFailures: [],
        lastUpdated: null,
        plcIp: '',
        plcPath: '',
      },
      { status: 500 }
    );
  }
}
