import { Request, Response } from 'express'
import { db } from '@/lib/db-sqlite'
import { pendingSyncRepository } from '@/lib/db/repositories/pending-sync-repository'
import { ioRepository } from '@/lib/db/repositories/io-repository'
import { getCloudSyncService } from '@/lib/cloud/cloud-sync-service'
import { getCloudSseClient } from '@/lib/cloud/cloud-sse-client'
import type { IoUpdateDto, SyncResult } from '@/lib/cloud/types'

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

    const result = await cloudSyncService.syncPendingUpdatesWithVersionControl(
      async (ioId: number) => {
        const io = await ioRepository.getById(ioId)
        if (!io) return null
        return {
          id: io.id,
          subsystemId: (io as any).SubsystemId ?? (io as any).subsystemId,
          name: (io as any).Name ?? (io as any).name ?? '',
          description: (io as any).Description ?? (io as any).description,
          result: (io as any).Result ?? (io as any).result,
          timestamp: (io as any).Timestamp ?? (io as any).timestamp,
          comments: (io as any).Comments ?? (io as any).comments,
          order: (io as any).Order ?? (io as any).order,
          version: (io as any).Version ?? (io as any).version,
          tagType: (io as any).TagType ?? (io as any).tagType,
        }
      }
    )

    const remainingPending = await pendingSyncRepository.getAll()
    const processedIds = new Set([
      ...result.successfulIds,
      ...result.failedIds,
      ...result.rejectedIds,
    ])

    const unprocessed = remainingPending.filter((p: any) => !processedIds.has(p.IoId ?? p.ioId))

    if (unprocessed.length > 0) {
      console.log(`[CloudSync] Processing ${unprocessed.length} unprocessed pending syncs from database`)

      for (const pending of unprocessed) {
        const p = pending as any
        const ioId = p.IoId ?? p.ioId
        const update: IoUpdateDto = {
          id: ioId,
          testedBy: p.InspectorName ?? p.inspectorName,
          result: p.TestResult ?? p.testResult,
          comments: p.Comments ?? p.comments,
          state: p.State ?? p.state,
          version: Number(p.Version ?? p.version),
          timestamp: p.Timestamp ? (typeof p.Timestamp === 'string' ? p.Timestamp : p.Timestamp.toISOString()) : undefined,
        }

        const synced = await cloudSyncService.syncIoUpdate(update)

        if (synced) {
          result.successfulIds.push(ioId)
          await pendingSyncRepository.delete(pending.id)
        } else {
          result.failedIds.push(ioId)
          await pendingSyncRepository.recordFailure(pending.id, 'Sync failed')
        }
      }
    }

    if (result.successfulIds.length > 0) {
      const rows = db.prepare(
        `SELECT id FROM PendingSyncs WHERE IoId IN (${result.successfulIds.map(() => '?').join(',')})`
      ).all(...result.successfulIds) as { id: number }[]
      if (rows.length > 0) {
        await pendingSyncRepository.deleteMany(rows.map((p) => p.id))
      }
    }

    if (result.rejectedIds.length > 0) {
      const rows = db.prepare(
        `SELECT id FROM PendingSyncs WHERE IoId IN (${result.rejectedIds.map(() => '?').join(',')})`
      ).all(...result.rejectedIds) as { id: number }[]
      if (rows.length > 0) {
        await pendingSyncRepository.deleteMany(rows.map((p) => p.id))
      }
    }

    console.log(
      `[CloudSync] Sync complete: ${result.successfulIds.length} synced, ${result.failedIds.length} failed, ${result.rejectedIds.length} rejected`
    )

    const errors: string[] = []
    result.errors.forEach((error, ioId) => {
      errors.push(`IO ${ioId}: ${error}`)
    })

    return res.json({
      success: result.failedIds.length === 0,
      syncedCount: result.successfulIds.length,
      failedCount: result.failedIds.length + result.rejectedIds.length,
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
