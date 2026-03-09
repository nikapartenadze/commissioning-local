/**
 * Configuration API Routes
 *
 * GET: Return current configuration
 * PUT: Update configuration
 *
 * Ported from C# backend/Controllers/ConfigurationController.cs
 */

import { NextResponse } from 'next/server';
import { configService } from '@/lib/config/config-service';
import { ConfigUpdateRequest } from '@/lib/config/types';

/**
 * GET /api/configuration
 * Returns the current application configuration.
 */
export async function GET() {
  try {
    const config = await configService.getConfig();

    return NextResponse.json({
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
    return NextResponse.json(
      { error: 'Failed to retrieve configuration' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/configuration
 * Updates the application configuration.
 *
 * Request body: ConfigUpdateRequest (partial config)
 * Response: Updated configuration
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json() as ConfigUpdateRequest;

    // Validate required fields if this is a full config update
    if (body.ip !== undefined && !body.ip) {
      return NextResponse.json(
        { error: 'IP address is required' },
        { status: 400 }
      );
    }

    if (body.path !== undefined && !body.path) {
      return NextResponse.json(
        { error: 'Path is required' },
        { status: 400 }
      );
    }

    // Save the updated configuration
    const updatedConfig = await configService.saveConfig(body);

    console.log('[Configuration API] Configuration updated:', {
      ip: updatedConfig.ip,
      subsystemId: updatedConfig.subsystemId,
    });

    return NextResponse.json({
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
    return NextResponse.json(
      { error: 'Failed to update configuration' },
      { status: 500 }
    );
  }
}
