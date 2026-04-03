export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { db } from '@/lib/db-sqlite'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'
import type { CloudSyncStatusResponse } from '@/lib/cloud/types'

/**
 * GET /api/cloud/status
 *
 * Get cloud connection status and pending sync count.
 *
 * Response:
 * {
 *   connected: boolean,
 *   pendingSyncCount: number,
 *   lastSyncAttempt?: string,
 *   lastSuccessfulSync?: string,
 *   error?: string
 * }
 */
export async function GET(): Promise<NextResponse<CloudSyncStatusResponse>> {
  try {
    // Get pending sync count from database
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs').get() as { cnt: number }
    const pendingSyncCount = countRow.cnt

    // Cloud sync service reads config from configService on demand
    const cloudSyncService = getCloudSyncService()
    const config = await cloudSyncService.getConfig()

    // Use SSE connection state if available (real-time, no HTTP overhead)
    // Fall back to health check only if SSE is not running
    let connected = false
    let error: string | undefined

    const sseClient = getCloudSseClient()
    if (sseClient) {
      connected = sseClient.isConnected
      if (!connected && sseClient.connectionState === 'reconnecting') {
        error = 'Reconnecting to cloud...'
      }
    } else if (config.remoteUrl) {
      try {
        connected = await cloudSyncService.isCloudAvailable()
        if (connected) {
          cloudSyncService.setConnectionState('connected')
        }
      } catch (e) {
        error = e instanceof Error ? e.message : 'Connection check failed'
      }
    } else {
      error = 'Remote URL not configured'
    }

    // Get stats for additional info
    const failedRow = db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE RetryCount > 0').get() as { cnt: number }
    const oldestRow = db.prepare('SELECT CreatedAt FROM PendingSyncs ORDER BY CreatedAt ASC LIMIT 1').get() as { CreatedAt: string } | undefined

    return NextResponse.json({
      connected,
      pendingSyncCount,
      lastSyncAttempt: oldestRow?.CreatedAt ?? undefined,
      error,
    })
  } catch (error) {
    console.error('[CloudStatus] Error getting cloud status:', error)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    return NextResponse.json({
      connected: false,
      pendingSyncCount: 0,
      error: errorMessage,
    })
  }
}

/**
 * POST /api/cloud/status
 *
 * Update cloud configuration and test connection.
 *
 * Request body:
 * {
 *   remoteUrl?: string,
 *   apiPassword?: string,
 *   subsystemId?: number
 * }
 *
 * Response:
 * {
 *   connected: boolean,
 *   pendingSyncCount: number,
 *   error?: string
 * }
 */
export async function POST(request: Request): Promise<NextResponse<CloudSyncStatusResponse>> {
  try {
    const body = await request.json().catch(() => ({}))
    const { remoteUrl, apiPassword, subsystemId } = body

    // Update cloud sync service configuration
    const cloudSyncService = getCloudSyncService()

    if (remoteUrl || apiPassword || subsystemId) {
      await cloudSyncService.updateConfig({
        ...(remoteUrl && { remoteUrl }),
        ...(apiPassword && { apiPassword }),
        ...(subsystemId && { subsystemId }),
      })
    }

    // Test connection
    let connected = false
    let error: string | undefined

    const config = await cloudSyncService.getConfig()

    if (config.remoteUrl) {
      try {
        connected = await cloudSyncService.isCloudAvailable()
        if (!connected) {
          error = 'Cloud server is not reachable'
        }
      } catch (e) {
        error = e instanceof Error ? e.message : 'Connection test failed'
        connected = false
      }
    } else {
      error = 'Remote URL not configured'
    }

    // Get pending sync count
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs').get() as { cnt: number }
    const pendingSyncCount = countRow.cnt

    return NextResponse.json({
      connected,
      pendingSyncCount,
      error,
    })
  } catch (error) {
    console.error('[CloudStatus] Error updating cloud status:', error)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    return NextResponse.json(
      {
        connected: false,
        pendingSyncCount: 0,
        error: errorMessage,
      },
      { status: 500 }
    )
  }
}
