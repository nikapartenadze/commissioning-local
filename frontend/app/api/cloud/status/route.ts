import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'
import type { CloudSyncStatusResponse } from '@/lib/cloud/types'

export async function GET(req: Request, res: Response) {
  try {
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs').get() as { cnt: number }
    const pendingSyncCount = countRow.cnt

    const cloudSyncService = getCloudSyncService()
    const config = await cloudSyncService.getConfig()

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

    const failedRow = db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE RetryCount > 0').get() as { cnt: number }
    const oldestRow = db.prepare('SELECT CreatedAt FROM PendingSyncs ORDER BY CreatedAt ASC LIMIT 1').get() as { CreatedAt: string } | undefined

    return res.json({
      connected,
      pendingSyncCount,
      lastSyncAttempt: oldestRow?.CreatedAt ?? undefined,
      error,
    } as CloudSyncStatusResponse)
  } catch (error) {
    console.error('[CloudStatus] Error getting cloud status:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return res.json({ connected: false, pendingSyncCount: 0, error: errorMessage } as CloudSyncStatusResponse)
  }
}

export async function POST(req: Request, res: Response) {
  try {
    const body = req.body || {}
    const { remoteUrl, apiPassword, subsystemId } = body

    const cloudSyncService = getCloudSyncService()

    if (remoteUrl || apiPassword || subsystemId) {
      await cloudSyncService.updateConfig({
        ...(remoteUrl && { remoteUrl }),
        ...(apiPassword && { apiPassword }),
        ...(subsystemId && { subsystemId }),
      })
    }

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

    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs').get() as { cnt: number }
    const pendingSyncCount = countRow.cnt

    return res.json({ connected, pendingSyncCount, error } as CloudSyncStatusResponse)
  } catch (error) {
    console.error('[CloudStatus] Error updating cloud status:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ connected: false, pendingSyncCount: 0, error: errorMessage } as CloudSyncStatusResponse)
  }
}
