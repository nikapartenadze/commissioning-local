import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'
import { getAutoSyncService } from '@/lib/cloud/auto-sync'
import { configService } from '@/lib/config'
import { resolveBackupsDirPath, resolveDatabasePath } from '@/lib/storage-paths'
import type { CloudSyncStatusResponse } from '@/lib/cloud/types'

export async function GET(req: Request, res: Response) {
  try {
    const pendingIoSyncCount = (db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs').get() as { cnt: number }).cnt
    const pendingL2SyncCount = (db.prepare('SELECT COUNT(*) as cnt FROM L2PendingSyncs').get() as { cnt: number }).cnt
    const pendingChangeRequestCount = (db.prepare("SELECT COUNT(*) as cnt FROM ChangeRequests WHERE Status = 'pending' AND CloudId IS NULL").get() as { cnt: number }).cnt
    const totalPendingCount = pendingIoSyncCount + pendingL2SyncCount + pendingChangeRequestCount

    const cloudSyncService = getCloudSyncService()
    const config = await cloudSyncService.getConfig()
    const autoSyncService = getAutoSyncService()
    const autoSyncStatus = autoSyncService ? autoSyncService.getStatus() : null

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

    const failedIoSyncCount = (db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs WHERE RetryCount > 0').get() as { cnt: number }).cnt
    const failedL2SyncCount = (db.prepare('SELECT COUNT(*) as cnt FROM L2PendingSyncs WHERE RetryCount > 0').get() as { cnt: number }).cnt
    const oldestIoRow = db.prepare('SELECT CreatedAt FROM PendingSyncs ORDER BY CreatedAt ASC LIMIT 1').get() as { CreatedAt: string } | undefined
    const oldestL2Row = db.prepare('SELECT CreatedAt FROM L2PendingSyncs ORDER BY CreatedAt ASC LIMIT 1').get() as { CreatedAt: string } | undefined
    const oldestChangeRequestRow = db.prepare("SELECT CreatedAt FROM ChangeRequests WHERE Status = 'pending' AND CloudId IS NULL ORDER BY CreatedAt ASC LIMIT 1").get() as { CreatedAt: string } | undefined
    const dirtyQueues = [
      pendingIoSyncCount > 0 ? 'io' : null,
      pendingL2SyncCount > 0 ? 'l2' : null,
      pendingChangeRequestCount > 0 ? 'change-requests' : null,
    ].filter(Boolean) as string[]

    return res.json({
      connected,
      connectionState: sseClient?.connectionState ?? cloudSyncService.connectionState,
      pendingSyncCount: pendingIoSyncCount,
      pendingIoSyncCount,
      pendingL2SyncCount,
      pendingChangeRequestCount,
      totalPendingCount,
      failedIoSyncCount,
      failedL2SyncCount,
      oldestPendingIoSync: oldestIoRow?.CreatedAt ?? undefined,
      oldestPendingL2Sync: oldestL2Row?.CreatedAt ?? undefined,
      oldestPendingChangeRequest: oldestChangeRequestRow?.CreatedAt ?? undefined,
      lastSyncAttempt: oldestIoRow?.CreatedAt ?? oldestL2Row?.CreatedAt ?? oldestChangeRequestRow?.CreatedAt ?? undefined,
      pullBlocked: totalPendingCount > 0,
      dirtyQueues,
      autoSyncRunning: autoSyncStatus?.running ?? false,
      lastPushAt: autoSyncStatus?.lastPushAt ?? undefined,
      lastPullAt: autoSyncStatus?.lastPullAt ?? undefined,
      lastPushResult: autoSyncStatus?.lastPushResult ?? undefined,
      lastPullResult: autoSyncStatus?.lastPullResult ?? undefined,
      configPath: configService.getConfigFilePath(),
      databasePath: resolveDatabasePath(),
      backupsPath: resolveBackupsDirPath(),
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

    const pendingSyncCount = (db.prepare('SELECT COUNT(*) as cnt FROM PendingSyncs').get() as { cnt: number }).cnt

    return res.json({ connected, pendingSyncCount, error } as CloudSyncStatusResponse)
  } catch (error) {
    console.error('[CloudStatus] Error updating cloud status:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return res.status(500).json({ connected: false, pendingSyncCount: 0, error: errorMessage } as CloudSyncStatusResponse)
  }
}
