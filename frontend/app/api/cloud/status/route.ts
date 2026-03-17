export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server'
import { pendingSyncRepository } from '@/lib/db/repositories/pending-sync-repository'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
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
    const pendingSyncCount = await pendingSyncRepository.count()

    // Get cloud sync service status
    const cloudSyncService = getCloudSyncService()
    const config = cloudSyncService.getConfig()

    // Determine connection status
    let connected = cloudSyncService.isConnected
    let error: string | undefined

    // If we have a remote URL configured, check actual connectivity
    if (config.remoteUrl && !connected) {
      try {
        connected = await cloudSyncService.isCloudAvailable()
      } catch (e) {
        error = e instanceof Error ? e.message : 'Connection check failed'
        connected = false
      }
    } else if (!config.remoteUrl) {
      error = 'Remote URL not configured'
      connected = false
    }

    // Get stats for additional info
    const stats = await pendingSyncRepository.getStats()

    return NextResponse.json({
      connected,
      pendingSyncCount,
      lastSyncAttempt: stats.oldestTimestamp?.toISOString(),
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
      cloudSyncService.updateConfig({
        ...(remoteUrl && { remoteUrl }),
        ...(apiPassword && { apiPassword }),
        ...(subsystemId && { subsystemId }),
      })
    }

    // Test connection
    let connected = false
    let error: string | undefined

    const config = cloudSyncService.getConfig()

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
    const pendingSyncCount = await pendingSyncRepository.count()

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
