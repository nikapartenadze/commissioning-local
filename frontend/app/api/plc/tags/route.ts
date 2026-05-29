import { Request, Response } from 'express'
import { getPlcTags, getPlcStatus } from '@/lib/plc-client-manager';
import {
  getMcmStatus,
  getMcmTags,
  hasMcm,
  hasAnyMcm,
} from '@/lib/mcm-registry';
import { configService } from '@/lib/config';

export async function GET(req: Request, res: Response) {
  try {
    // Multi-MCM scoping: ?subsystemId= → scope to a specific MCM.
    // Otherwise, if any MCM is registered, return its tags (registry is the
    // source of truth in multi-MCM mode). Else fall back to the legacy
    // singleton aggregate.
    const querySubsystemId =
      typeof req.query.subsystemId === 'string' ? req.query.subsystemId : undefined;

    let connected: boolean;
    let statusStr: string;
    let tags: any[];
    let plcIp: string;
    let plcPath: string;

    if (querySubsystemId) {
      if (!hasMcm(querySubsystemId)) {
        return res.status(404).json({
          success: false,
          error: `MCM ${querySubsystemId} not configured or never connected`,
          subsystemId: querySubsystemId,
          tags: [],
          count: 0,
          plcConnected: false,
        });
      }
      const mcm = getMcmStatus(querySubsystemId);
      const t = getMcmTags(querySubsystemId);
      connected = mcm?.connected ?? false;
      statusStr = mcm?.status ?? 'disconnected';
      tags = t.tags;
      plcIp = mcm?.ip ?? '';
      plcPath = mcm?.path ?? '';
    } else {
      const legacyStatus = getPlcStatus();
      const legacyTags = getPlcTags();
      const config = await configService.getConfig();
      connected = legacyStatus.connected || hasAnyMcm();
      statusStr = legacyStatus.status;
      tags = legacyTags.tags;
      plcIp = legacyStatus.connectionConfig?.ip || config.ip || '';
      plcPath = legacyStatus.connectionConfig?.path || config.path || '1,0';
    }

    const totalTags = tags.length;
    const successfulTags = tags.filter((t: any) => t.state !== undefined && t.state !== null).length;
    const failedTags = totalTags - successfulTags;
    const successRate = totalTags > 0 ? Math.round((successfulTags / totalTags) * 100) : 0;

    return res.json({
      success: true,
      connected,
      status: statusStr,
      tags,
      count: totalTags,
      plcConnected: connected,
      subsystemId: querySubsystemId,
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
      plcIp,
      plcPath,
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
