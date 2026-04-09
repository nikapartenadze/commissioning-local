/**
 * Configuration API Routes
 *
 * GET: Return current configuration
 * PUT: Update configuration
 */

import { Request, Response } from 'express'
import { configService } from '@/lib/config/config-service';
import { ConfigUpdateRequest } from '@/lib/config/types';

/**
 * GET /api/configuration
 */
export async function GET(req: Request, res: Response) {
  try {
    const config = await configService.getConfig();

    return res.json({
      ip: config.ip,
      path: config.path,
      remoteUrl: config.remoteUrl,
      apiPassword: config.apiPassword,
      subsystemId: config.subsystemId,
      orderMode: config.orderMode,
      syncBatchSize: config.syncBatchSize,
      syncBatchDelayMs: config.syncBatchDelayMs,
      showStateColumn: config.showStateColumn,
      showResultColumn: config.showResultColumn,
      showTimestampColumn: config.showTimestampColumn,
      showHistoryColumn: config.showHistoryColumn,
      isConfigured: configService.isConfigured(),
    });
  } catch (error) {
    console.error('[Configuration API] Error getting config:', error);
    return res.status(500).json({ error: 'Failed to retrieve configuration' });
  }
}

/**
 * PUT /api/configuration
 */
export async function PUT(req: Request, res: Response) {
  try {
    const body = req.body as ConfigUpdateRequest;

    if (body.ip !== undefined && !body.ip) {
      return res.status(400).json({ error: 'IP address is required' });
    }

    if (body.path !== undefined && !body.path) {
      return res.status(400).json({ error: 'Path is required' });
    }

    const updatedConfig = await configService.saveConfig(body);

    console.log('[Configuration API] Configuration updated:', {
      ip: updatedConfig.ip,
      subsystemId: updatedConfig.subsystemId,
    });

    return res.json({
      message: 'Configuration updated successfully',
      config: {
        ip: updatedConfig.ip,
        path: updatedConfig.path,
        remoteUrl: updatedConfig.remoteUrl,
        apiPassword: updatedConfig.apiPassword,
        subsystemId: updatedConfig.subsystemId,
        orderMode: updatedConfig.orderMode,
        syncBatchSize: updatedConfig.syncBatchSize,
        syncBatchDelayMs: updatedConfig.syncBatchDelayMs,
        showStateColumn: updatedConfig.showStateColumn,
        showResultColumn: updatedConfig.showResultColumn,
        showTimestampColumn: updatedConfig.showTimestampColumn,
        showHistoryColumn: updatedConfig.showHistoryColumn,
      },
      isConfigured: configService.isConfigured(),
    });
  } catch (error) {
    console.error('[Configuration API] Error updating config:', error);
    return res.status(500).json({ error: 'Failed to update configuration' });
  }
}
