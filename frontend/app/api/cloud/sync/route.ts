import { Request, Response } from 'express'
import { pendingSyncRepository } from '@/lib/db/repositories/pending-sync-repository'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'
import { mapPendingSyncToIoUpdate } from '@/lib/cloud/pending-sync-utils'
import type { SyncResult } from '@/lib/cloud/types'

export async function POST(req: Request, res: Response) {
  try {
    const body = req.body || {}
    const { remoteUrl, apiPassword, batchSize = 50, force = false } = body

    console.log('[CloudSync] Starting pending sync processing...')

    const pendingSyncs = await pendingSyncRepository.getAll()

    if (pendingSyncs.length === 0) {
      console.log('[CloudSync] No pending syncs to process')

      const syncService = getCloudSyncService()
      const config = await syncService.getConfig()
      const serverUrl = remoteUrl || config.remoteUrl

      if (serverUrl) {
        try {
          const healthCheck = await fetch(`${serverUrl}/api/sync/health`, {
            method: 'GET',
            headers: { 'X-API-Key': apiPassword || config.apiPassword || '' },
            signal: AbortSignal.timeout(10000),
          })
          if (healthCheck.ok) {
            syncService.setConnectionState('connected')
          }
        } catch {
          // Server unreachable
        }
      }

      return res.json({ success: true, syncedCount: 0, failedCount: 0 } as SyncResult)
    }

    console.log(`[CloudSync] Found ${pendingSyncs.length} pending syncs`)

    const cloudSyncService = getCloudSyncService()

    if (remoteUrl || apiPassword) {
      await cloudSyncService.updateConfig({
        ...(remoteUrl && { remoteUrl }),
        ...(apiPassword && { apiPassword }),
        batchSize,
      })
    }

    const sseClient = getCloudSseClient()
    const sseConnected = sseClient?.isConnected ?? false
    const isAvailable = sseConnected || await cloudSyncService.isCloudAvailable()
    if (!isAvailable && !force) {
      console.warn('[CloudSync] Cloud not available, keeping items in queue')
      return res.json({
        success: false,
        syncedCount: 0,
        failedCount: pendingSyncs.length,
        errors: ['Cloud server is not reachable'],
      } as SyncResult)
    }

    const successfulIds: number[] = []
    const failedIds: number[] = []
    const blockedIoIds = new Set<number>()
    const errors: string[] = []

    for (const pending of pendingSyncs) {
      const ioId = pending.IoId

      // Preserve per-IO ordering: if one change failed, leave later changes for that IO untouched.
      if (blockedIoIds.has(ioId)) {
        continue
      }

      const synced = await cloudSyncService.syncIoUpdate(mapPendingSyncToIoUpdate(pending))

      if (synced) {
        successfulIds.push(ioId)
        await pendingSyncRepository.delete(pending.id)
      } else {
        failedIds.push(ioId)
        blockedIoIds.add(ioId)
        await pendingSyncRepository.recordFailure(pending.id, 'Sync failed')
        errors.push(`IO ${ioId}: Sync failed`)
      }
    }

    console.log(
      `[CloudSync] Sync complete: ${successfulIds.length} synced, ${failedIds.length} failed`
    )

    return res.json({
      success: failedIds.length === 0,
      syncedCount: successfulIds.length,
      failedCount: failedIds.length,
      errors: errors.length > 0 ? errors : undefined,
    } as SyncResult)
  } catch (error) {
    console.error('[CloudSync] Error processing pending syncs:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
    return res.status(500).json({
      success: false,
      syncedCount: 0,
      failedCount: 0,
      errors: [errorMessage],
    } as SyncResult)
  }
}

export async function GET(req: Request, res: Response) {
  try {
    const stats = await pendingSyncRepository.getStats()
    const cloudSyncService = getCloudSyncService()

    return res.json({
      pendingCount: stats.total,
      failedCount: stats.failed,
      maxRetries: stats.maxRetries,
      oldestPending: stats.oldestTimestamp ?? null,
      connectionState: cloudSyncService.connectionState,
      isConnected: cloudSyncService.isConnected,
    })
  } catch (error) {
    console.error('[CloudSync] Error getting sync status:', error)
    return res.status(500).json({ error: 'Failed to get sync status' })
  }
}
