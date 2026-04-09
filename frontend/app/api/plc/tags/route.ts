import { Request, Response } from 'express'
import { getPlcTags, getPlcStatus } from '@/lib/plc-client-manager';
import { configService } from '@/lib/config';

export async function GET(req: Request, res: Response) {
  try {
    const status = getPlcStatus();
    const tagsResult = getPlcTags();
    const config = await configService.getConfig();

    const totalTags = tagsResult.count || 0;
    const successfulTags = tagsResult.tags ? tagsResult.tags.filter((t: any) => t.state !== undefined && t.state !== null).length : 0;
    const failedTags = totalTags - successfulTags;
    const successRate = totalTags > 0 ? Math.round((successfulTags / totalTags) * 100) : 0;

    return res.json({
      success: true,
      connected: status.connected,
      status: status.status,
      tags: tagsResult.tags,
      count: tagsResult.count,
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
    return res.status(500).json({
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
    });
  }
}
